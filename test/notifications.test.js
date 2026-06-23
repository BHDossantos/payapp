import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/lib/store.js';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  server = createServer(createApp({ store: new Store({ filePath: null }) }));
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
const notifs = async (token, q = '') => (await api('GET', `/notifications${q}`, { token })).json;

test('a P2P send notifies both recipient and sender', async () => {
  const a = await reg({ email: 'na@x.com', phone: '+351930000001', username: 'na_sender' });
  const b = await reg({ email: 'nb@x.com', phone: '+351930000002', username: 'nb_receiver' });
  await api('POST', '/wallet/topup', { token: a.token, body: { amount: 50 } });
  await api('POST', '/wallet/send', { token: a.token, body: { username: 'nb_receiver', amount: 10, note: 'Coffee' } });

  const recv = await notifs(b.token);
  assert.equal(recv.unread_count, 1);
  assert.equal(recv.notifications[0].type, 'money_received');
  assert.match(recv.notifications[0].body, /Coffee/);

  const sent = await notifs(a.token);
  assert.ok(sent.notifications.some((n) => n.type === 'money_sent'));
});

test('unread filter, mark-one-read, and mark-all-read', async () => {
  const a = await reg({ email: 'nc@x.com', phone: '+351930000003', username: 'nc_a' });
  const b = await reg({ email: 'nd@x.com', phone: '+351930000004', username: 'nd_b' });
  await api('POST', '/wallet/topup', { token: a.token, body: { amount: 50 } });
  await api('POST', '/wallet/send', { token: a.token, body: { username: 'nd_b', amount: 1 } });
  await api('POST', '/wallet/send', { token: a.token, body: { username: 'nd_b', amount: 2 } });

  let list = await notifs(b.token);
  assert.equal(list.unread_count, 2);

  // unread filter returns only unread
  const unread = await notifs(b.token, '?unread=true');
  assert.equal(unread.notifications.length, 2);
  assert.ok(unread.notifications.every((n) => n.read === false));

  // mark the first one read
  const first = list.notifications[0].notification_id;
  const marked = await api('POST', `/notifications/${first}/read`, { token: b.token });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.read, true);

  list = await notifs(b.token);
  assert.equal(list.unread_count, 1);

  // mark all read
  const all = await api('POST', '/notifications/read-all', { token: b.token });
  assert.equal(all.json.marked, 1);
  list = await notifs(b.token);
  assert.equal(list.unread_count, 0);
});

test('cannot mark someone else\'s notification read (404)', async () => {
  const a = await reg({ email: 'ne@x.com', phone: '+351930000005', username: 'ne_a' });
  const b = await reg({ email: 'nf@x.com', phone: '+351930000006', username: 'nf_b' });
  const c = await reg({ email: 'ng@x.com', phone: '+351930000007', username: 'ng_c' });
  await api('POST', '/wallet/topup', { token: a.token, body: { amount: 50 } });
  await api('POST', '/wallet/send', { token: a.token, body: { username: 'nf_b', amount: 5 } });

  const bList = await notifs(b.token);
  const id = bList.notifications[0].notification_id;
  const res = await api('POST', `/notifications/${id}/read`, { token: c.token });
  assert.equal(res.status, 404);
});

test('payment request notifies recipient; paying notifies requestor', async () => {
  const a = await reg({ email: 'nh@x.com', phone: '+351930000008', username: 'nh_req' });
  const b = await reg({ email: 'ni@x.com', phone: '+351930000009', username: 'ni_payer' });
  await api('POST', '/wallet/topup', { token: b.token, body: { amount: 50 } });

  const created = await api('POST', '/wallet/request', {
    token: a.token, body: { username: 'ni_payer', amount: 12, reason: 'Tickets' },
  });
  const bList = await notifs(b.token);
  assert.ok(bList.notifications.some((n) => n.type === 'payment_request'));

  await api('POST', `/wallet/requests/${created.json.request_id}/pay`, { token: b.token });
  const aList = await notifs(a.token);
  assert.ok(aList.notifications.some((n) => n.type === 'request_paid'));
});

test('creating a split notifies the other participants', async () => {
  const creator = await reg({ email: 'nj@x.com', phone: '+351930000010', username: 'nj_creator' });
  const p = await reg({ email: 'nk@x.com', phone: '+351930000011', username: 'nk_part' });
  await api('POST', '/wallet/split', {
    token: creator.token,
    body: {
      name: 'Trip', split: 'equal', total: 40,
      participants: [{ username: 'nj_creator' }, { username: 'nk_part' }],
    },
  });
  const pList = await notifs(p.token);
  assert.ok(pList.notifications.some((n) => n.type === 'split_request'));
  // creator should NOT receive a split_request for their own split
  const cList = await notifs(creator.token);
  assert.ok(!cList.notifications.some((n) => n.type === 'split_request'));
});
