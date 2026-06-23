import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/lib/store.js';
import { createApp } from '../src/app.js';

let server;
let base;
let store;

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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const baseUser = (over) => ({
  first_name: 'Test', last_name: 'User', country: 'PT', password: 'supersecret', ...over,
});

async function register(over) {
  return (await api('POST', '/auth/register', { body: baseUser(over) })).json;
}

let adminToken;
let normalToken;
let merchantId;
let normalUserId;

test('setup: admin, normal user, merchant, and some transactions', async () => {
  const adminAcct = await register({ email: 'admin@euroflow.eu', phone: '+351900000001', username: 'admin' });
  adminToken = adminAcct.token;
  // Promote directly in the store (env-based bootstrap runs at import time).
  store.update('users', adminAcct.user.user_id, { isAdmin: true });

  const normal = await register({ email: 'user@euroflow.eu', phone: '+351900000002', username: 'normaluser' });
  normalToken = normal.token;
  normalUserId = normal.user.user_id;

  const receiver = await register({ email: 'recv@euroflow.eu', phone: '+351900000003', username: 'receiveruser' });

  // Fund the normal user and move some money so the ledger isn't empty.
  await api('POST', '/wallet/topup', { token: normalToken, body: { amount: 5000 } });
  await api('POST', '/wallet/send', { token: normalToken, body: { username: 'receiveruser', amount: 25 } });

  // A merchant pending approval.
  const m = await api('POST', '/merchant/register', {
    token: normalToken, body: { business_name: 'Pending Shop', country: 'PT' },
  });
  merchantId = m.json.merchant_id;
  assert.equal(m.json.status, 'pending');
  assert.ok(receiver.user.user_id);
});

test('non-admin is forbidden from admin routes (403)', async () => {
  const res = await api('GET', '/admin/users', { token: normalToken });
  assert.equal(res.status, 403);
});

test('unauthenticated admin route returns 401', async () => {
  const res = await api('GET', '/admin/users');
  assert.equal(res.status, 401);
});

test('admin can list users with enriched fields', async () => {
  const res = await api('GET', '/admin/users', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.json.users.length >= 3);
  const normal = res.json.users.find((u) => u.user_id === normalUserId);
  assert.equal(normal.merchant_status, 'pending');
  assert.equal(typeof normal.balance, 'number');
});

test('admin can list and filter transactions', async () => {
  const all = await api('GET', '/admin/transactions', { token: adminToken });
  assert.equal(all.status, 200);
  assert.ok(all.json.transactions.length >= 1);
  const completed = await api('GET', '/admin/transactions?status=completed', { token: adminToken });
  assert.ok(completed.json.transactions.every((t) => t.status === 'completed'));
});

test('admin merchant approval lifecycle', async () => {
  const pending = await api('GET', '/admin/merchants?status=pending', { token: adminToken });
  assert.ok(pending.json.merchants.some((m) => m.merchant_id === merchantId));

  const approved = await api('POST', `/admin/merchants/${merchantId}/approve`, { token: adminToken });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, 'active');

  const suspended = await api('POST', `/admin/merchants/${merchantId}/suspend`, { token: adminToken });
  assert.equal(suspended.json.status, 'suspended');

  const bad = await api('POST', `/admin/merchants/${merchantId}/frobnicate`, { token: adminToken });
  assert.equal(bad.status, 400);
});

test('admin can set KYC status', async () => {
  const res = await api('POST', `/admin/users/${normalUserId}/kyc`, {
    token: adminToken, body: { status: 'verified' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.kyc_status, 'verified');

  const bad = await api('POST', `/admin/users/${normalUserId}/kyc`, {
    token: adminToken, body: { status: 'banana' },
  });
  assert.equal(bad.status, 400);
});

test('AML alerts flag large transfers and high velocity', async () => {
  // Large transfer (>= EUR 1000 default threshold).
  await api('POST', '/wallet/send', { token: normalToken, body: { username: 'receiveruser', amount: 1500 } });
  // Burst of 5 small sends to trip the velocity rule.
  for (let i = 0; i < 5; i++) {
    await api('POST', '/wallet/send', { token: normalToken, body: { username: 'receiveruser', amount: 1 } });
  }
  const res = await api('GET', '/admin/aml/alerts', { token: adminToken });
  assert.equal(res.status, 200);
  const types = res.json.alerts.map((a) => a.type);
  assert.ok(types.includes('large_transfer'), 'expected a large_transfer alert');
  assert.ok(types.includes('high_velocity'), 'expected a high_velocity alert');
});

test('admin stats summary aggregates the system', async () => {
  const res = await api('GET', '/admin/stats', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.json.users.total >= 3);
  assert.equal(res.json.users.admins, 1);
  assert.ok(res.json.transactions.volume_completed > 0);
  assert.ok(res.json.aml.open_alerts >= 1);
});
