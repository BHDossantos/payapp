import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/lib/store.js';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  const store = new Store({ filePath: null }); // in-memory only
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

test('health check', async () => {
  const { status, json } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('register creates a user + wallet and returns a token', async () => {
  const { status, json } = await api('POST', '/auth/register', {
    body: baseUser({ email: 'alice@example.com', phone: '+351911111111', username: 'alice' }),
  });
  assert.equal(status, 201);
  assert.ok(json.token);
  assert.equal(json.user.email, 'alice@example.com');
  assert.equal(json.wallet.balance, 0);
  assert.equal(json.wallet.currency, 'EUR');
});

test('duplicate email is rejected', async () => {
  await api('POST', '/auth/register', { body: baseUser({ email: 'dup@example.com', phone: '+351911111112' }) });
  const { status, json } = await api('POST', '/auth/register', {
    body: baseUser({ email: 'dup@example.com', phone: '+351911111113' }),
  });
  assert.equal(status, 409);
  assert.match(json.error, /already exists/);
});

test('weak password is rejected', async () => {
  const { status } = await api('POST', '/auth/register', {
    body: baseUser({ email: 'weak@example.com', phone: '+351911111114', password: 'short' }),
  });
  assert.equal(status, 400);
});

test('login works and protected routes require a token', async () => {
  await api('POST', '/auth/register', { body: baseUser({ email: 'bob@example.com', phone: '+351922222222', username: 'bob' }) });
  const login = await api('POST', '/auth/login', { body: { email: 'bob@example.com', password: 'supersecret' } });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);

  const noAuth = await api('GET', '/wallet');
  assert.equal(noAuth.status, 401);

  const withAuth = await api('GET', '/wallet', { token: login.json.token });
  assert.equal(withAuth.status, 200);
});

test('full P2P flow: top up, send, history, balances', async () => {
  const a = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'sender@example.com', phone: '+351933333331', username: 'sender' }),
  })).json;
  const b = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'receiver@example.com', phone: '+351933333332', username: 'receiver' }),
  })).json;

  await api('POST', '/wallet/topup', { token: a.token, body: { amount: 100 } });

  const send = await api('POST', '/wallet/send', {
    token: a.token,
    body: { username: 'receiver', amount: 30.50, note: 'Lunch' },
  });
  assert.equal(send.status, 201);
  assert.equal(send.json.status, 'completed');
  assert.equal(send.json.amount, 30.5);
  assert.equal(send.json.direction, 'sent');

  const senderWallet = await api('GET', '/wallet', { token: a.token });
  assert.equal(senderWallet.json.balance, 69.5);
  const receiverWallet = await api('GET', '/wallet', { token: b.token });
  assert.equal(receiverWallet.json.balance, 30.5);

  const hist = await api('GET', '/wallet/history', { token: b.token });
  assert.equal(hist.json.transactions.length, 1);
  assert.equal(hist.json.transactions[0].direction, 'received');
});

test('sending more than balance fails with 402', async () => {
  const a = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'poor@example.com', phone: '+351944444441', username: 'poor' }),
  })).json;
  await api('POST', '/auth/register', { body: baseUser({ email: 'rich@example.com', phone: '+351944444442', username: 'rich' }) });

  const send = await api('POST', '/wallet/send', { token: a.token, body: { username: 'rich', amount: 5 } });
  assert.equal(send.status, 402);
  assert.match(send.json.error, /Insufficient/);
});

test('cannot send to yourself', async () => {
  const a = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'self@example.com', phone: '+351955555551', username: 'selfie' }),
  })).json;
  await api('POST', '/wallet/topup', { token: a.token, body: { amount: 10 } });
  const send = await api('POST', '/wallet/send', { token: a.token, body: { username: 'selfie', amount: 1 } });
  assert.equal(send.status, 400);
});

test('payment request flow: create, pay, settle', async () => {
  const a = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'req1@example.com', phone: '+351966666661', username: 'req1' }),
  })).json;
  const b = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'req2@example.com', phone: '+351966666662', username: 'req2' }),
  })).json;
  await api('POST', '/wallet/topup', { token: b.token, body: { amount: 50 } });

  // a requests 20 from b
  const reqRes = await api('POST', '/wallet/request', {
    token: a.token, body: { username: 'req2', amount: 20, reason: 'Concert ticket' },
  });
  assert.equal(reqRes.status, 201);
  const requestId = reqRes.json.request_id;

  // b sees it in their incoming box
  const incoming = await api('GET', '/wallet/requests?box=incoming', { token: b.token });
  assert.equal(incoming.json.requests.length, 1);

  // b pays it
  const pay = await api('POST', `/wallet/requests/${requestId}/pay`, { token: b.token });
  assert.equal(pay.status, 200);
  assert.equal(pay.json.request.status, 'paid');

  const aWallet = await api('GET', '/wallet', { token: a.token });
  assert.equal(aWallet.json.balance, 20);
});

test('bill split: equal division and paying a share', async () => {
  const creator = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'c@example.com', phone: '+351977777771', username: 'creator' }),
  })).json;
  const p1 = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'p1@example.com', phone: '+351977777772', username: 'part1' }),
  })).json;
  await api('POST', '/auth/register', { body: baseUser({ email: 'p2@example.com', phone: '+351977777773', username: 'part2' }) });
  await api('POST', '/wallet/topup', { token: p1.token, body: { amount: 100 } });

  const split = await api('POST', '/wallet/split', {
    token: creator.token,
    body: {
      name: 'Dinner in Berlin',
      split: 'equal',
      total: 30,
      participants: [{ username: 'creator' }, { username: 'part1' }, { username: 'part2' }],
    },
  });
  assert.equal(split.status, 201);
  assert.equal(split.json.total, 30);
  // 30 / 3 = 10 each; creator's own share auto-settled.
  const creatorShare = split.json.participants.find((p) => p.user_id === creator.user.user_id);
  assert.equal(creatorShare.status, 'paid');

  const groupId = split.json.group_id;
  const pay = await api('POST', `/splits/${groupId}/pay`, { token: p1.token });
  assert.equal(pay.status, 200);
  const p1Share = pay.json.group.participants.find((p) => p.user_id === p1.user.user_id);
  assert.equal(p1Share.status, 'paid');
  assert.equal(pay.json.group.settled, 20); // creator (10) + p1 (10)
});

test('merchant + invoice + qr flow', async () => {
  const m = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'merchant@example.com', phone: '+351988888881', username: 'shop' }),
  })).json;

  const reg = await api('POST', '/merchant/register', {
    token: m.token, body: { business_name: 'Cafe Lisboa', vat_number: 'PT123456789', country: 'PT' },
  });
  assert.equal(reg.status, 201);
  assert.match(reg.json.payment_link, /cafe-lisboa/);

  const inv = await api('POST', '/invoice/create', {
    token: m.token, body: { customer_name: 'Jane', amount: 42.0, description: 'Catering' },
  });
  assert.equal(inv.status, 201);
  assert.equal(inv.json.status, 'open');

  const paid = await api('POST', `/invoices/${inv.json.invoice_id}/paid`, { token: m.token });
  assert.equal(paid.json.status, 'paid');

  const qr = await api('POST', '/qr/generate', { token: m.token, body: { type: 'dynamic', amount: 9.99 } });
  assert.equal(qr.status, 201);
  assert.match(qr.json.payload, /^euroflow:\/\/pay\?/);
  assert.match(qr.json.payload, /amount=9.99/);
});

test('kyc verify flips status', async () => {
  const u = (await api('POST', '/auth/register', {
    body: baseUser({ email: 'kyc@example.com', phone: '+351999999991', username: 'kycuser' }),
  })).json;
  assert.equal(u.user.kyc_status, 'unverified');
  const verified = await api('POST', '/kyc/verify', { token: u.token });
  assert.equal(verified.json.kyc_status, 'verified');
});
