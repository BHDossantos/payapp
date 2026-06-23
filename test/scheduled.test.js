import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/lib/store.js';
import { createApp } from '../src/app.js';

let server;
let base;
let store;
let adminToken;

before(async () => {
  store = new Store({ filePath: null });
  server = createServer(createApp({ store }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const baseUser = (over) => ({
  first_name: 'Test', last_name: 'User', country: 'PT', password: 'supersecret', ...over,
});
const reg = async (over) => (await api('POST', '/auth/register', { body: baseUser(over) })).json;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const runDue = () => api('POST', '/admin/schedules/run-due', { token: adminToken });

let seq = 0;
const phone = () => `+3519400${String(seq++).padStart(5, '0')}`;

test('setup admin', async () => {
  const admin = await reg({ email: 'sadmin@x.com', phone: phone(), username: 's_admin' });
  store.update('users', admin.user.user_id, { isAdmin: true });
  adminToken = admin.token;
});

test('monthly schedule generates a due request and advances next_run_at', async () => {
  const landlord = await reg({ email: 'll1@x.com', phone: phone(), username: 'landlord1' });
  const tenant = await reg({ email: 'tn1@x.com', phone: phone(), username: 'tenant1' });

  const created = await api('POST', '/schedules', {
    token: landlord.token,
    body: { username: 'tenant1', amount: 800, reason: 'Rent', frequency: 'monthly', start_date: daysAgo(1) },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.frequency, 'monthly');
  const id = created.json.schedule_id;

  await runDue();

  // Tenant now has a pending request and a notification.
  const inbox = await api('GET', '/wallet/requests?box=incoming', { token: tenant.token });
  const rentReqs = inbox.json.requests.filter((r) => r.reason === 'Rent');
  assert.equal(rentReqs.length, 1);

  const notifs = await api('GET', '/notifications', { token: tenant.token });
  assert.ok(notifs.json.notifications.some((n) => n.type === 'payment_request'));

  // Schedule advanced ~1 month into the future and counted the run.
  const after = await api('GET', `/schedules/${id}`, { token: landlord.token });
  assert.equal(after.json.runs_count, 1);
  assert.equal(after.json.status, 'active');
  assert.ok(Date.parse(after.json.next_run_at) > Date.now());
});

test('once schedule completes after a single run', async () => {
  const a = await reg({ email: 'once1@x.com', phone: phone(), username: 'once_a' });
  const b = await reg({ email: 'once2@x.com', phone: phone(), username: 'once_b' });
  const created = await api('POST', '/schedules', {
    token: a.token,
    body: { username: 'once_b', amount: 10, reason: 'One-off', frequency: 'once', start_date: daysAgo(1) },
  });
  const id = created.json.schedule_id;

  await runDue();
  let s = await api('GET', `/schedules/${id}`, { token: a.token });
  assert.equal(s.json.status, 'completed');
  assert.equal(s.json.runs_count, 1);

  // Running again must not generate more.
  await runDue();
  s = await api('GET', `/schedules/${id}`, { token: a.token });
  assert.equal(s.json.runs_count, 1);
});

test('paused schedule does not run; resuming lets it run', async () => {
  const a = await reg({ email: 'pz1@x.com', phone: phone(), username: 'pause_a' });
  const b = await reg({ email: 'pz2@x.com', phone: phone(), username: 'pause_b' });
  const created = await api('POST', '/schedules', {
    token: a.token,
    body: { username: 'pause_b', amount: 5, reason: 'Maybe', frequency: 'monthly', start_date: daysAgo(1) },
  });
  const id = created.json.schedule_id;

  const paused = await api('POST', `/schedules/${id}/pause`, { token: a.token });
  assert.equal(paused.json.status, 'paused');

  await runDue();
  let s = await api('GET', `/schedules/${id}`, { token: a.token });
  assert.equal(s.json.runs_count, 0);
  const inbox1 = await api('GET', '/wallet/requests?box=incoming', { token: b.token });
  assert.equal(inbox1.json.requests.length, 0);

  await api('POST', `/schedules/${id}/resume`, { token: a.token });
  await runDue();
  s = await api('GET', `/schedules/${id}`, { token: a.token });
  assert.equal(s.json.runs_count, 1);
});

test('weekly schedule catches up on missed periods', async () => {
  const a = await reg({ email: 'wk1@x.com', phone: phone(), username: 'weekly_a' });
  const b = await reg({ email: 'wk2@x.com', phone: phone(), username: 'weekly_b' });
  // Started 15 days ago: occurrences at -15, -8, -1 (all due), next at +6 (future).
  const created = await api('POST', '/schedules', {
    token: a.token,
    body: { username: 'weekly_b', amount: 12, reason: 'Weekly', frequency: 'weekly', start_date: daysAgo(15) },
  });
  const id = created.json.schedule_id;

  await runDue();
  const s = await api('GET', `/schedules/${id}`, { token: a.token });
  assert.equal(s.json.runs_count, 3);
  assert.ok(Date.parse(s.json.next_run_at) > Date.now());

  const inbox = await api('GET', '/wallet/requests?box=incoming', { token: b.token });
  assert.equal(inbox.json.requests.filter((r) => r.reason === 'Weekly').length, 3);
});

test('validation: cannot schedule to self; frequency must be valid', async () => {
  const a = await reg({ email: 'v1@x.com', phone: phone(), username: 'valid_a' });
  const self = await api('POST', '/schedules', {
    token: a.token, body: { username: 'valid_a', amount: 5, frequency: 'monthly' },
  });
  assert.equal(self.status, 400);

  await reg({ email: 'v2@x.com', phone: phone(), username: 'valid_b' });
  const badFreq = await api('POST', '/schedules', {
    token: a.token, body: { username: 'valid_b', amount: 5, frequency: 'hourly' },
  });
  assert.equal(badFreq.status, 400);
});

test('only the owner can manage a schedule; recipient can view it', async () => {
  const a = await reg({ email: 'o1@x.com', phone: phone(), username: 'owner_a' });
  const b = await reg({ email: 'o2@x.com', phone: phone(), username: 'payer_b' });
  const created = await api('POST', '/schedules', {
    token: a.token, body: { username: 'payer_b', amount: 5, frequency: 'monthly', start_date: daysAgo(0) },
  });
  const id = created.json.schedule_id;

  const forbidden = await api('POST', `/schedules/${id}/cancel`, { token: b.token });
  assert.equal(forbidden.status, 403);

  // Recipient can view but not manage.
  const view = await api('GET', `/schedules/${id}`, { token: b.token });
  assert.equal(view.status, 200);

  const cancelled = await api('POST', `/schedules/${id}/cancel`, { token: a.token });
  assert.equal(cancelled.json.status, 'cancelled');
});

test('listing schedules by box (outgoing vs incoming)', async () => {
  const a = await reg({ email: 'l1@x.com', phone: phone(), username: 'list_a' });
  const b = await reg({ email: 'l2@x.com', phone: phone(), username: 'list_b' });
  await api('POST', '/schedules', {
    token: a.token, body: { username: 'list_b', amount: 5, frequency: 'monthly' },
  });

  const outgoing = await api('GET', '/schedules?box=outgoing', { token: a.token });
  assert.ok(outgoing.json.schedules.length >= 1);
  const incoming = await api('GET', '/schedules?box=incoming', { token: b.token });
  assert.ok(incoming.json.schedules.some((s) => s.requestor_id === a.user.user_id));
});
