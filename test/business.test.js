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
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const baseUser = (over) => ({
  first_name: 'Test', last_name: 'User', country: 'PT', password: 'supersecret', ...over,
});
const reg = async (over) => (await api('POST', '/auth/register', { body: baseUser(over) })).json;

let seq = 0;
const phone = () => `+3519600${String(seq++).padStart(5, '0')}`;

async function newMerchant(username) {
  const owner = await reg({ email: `${username}@x.com`, phone: phone(), username });
  const reg2 = await api('POST', '/merchant/register', {
    token: owner.token, body: { business_name: `${username} Shop`, country: 'PT' },
  });
  return { owner, merchant: reg2.json };
}

test('paying a merchant by slug moves money and notifies them', async () => {
  const { owner, merchant } = await newMerchant('cafe');
  const payer = await reg({ email: 'pm1@x.com', phone: phone(), username: 'pm_payer1' });
  await api('POST', '/wallet/topup', { token: payer.token, body: { amount: 100 } });

  const pay = await api('POST', `/merchants/${merchant.slug}/pay`, {
    token: payer.token, body: { amount: 12.5, note: 'Coffee & cake' },
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.json.transaction.type, 'merchant');
  assert.equal(pay.json.transaction.amount, 12.5);

  const mWallet = await api('GET', '/wallet', { token: owner.token });
  assert.equal(mWallet.json.balance, 12.5);

  const notifs = await api('GET', '/notifications', { token: owner.token });
  assert.ok(notifs.json.notifications.some((n) => n.type === 'merchant_payment'));
});

test('public merchant lookup does not leak the owner id', async () => {
  const { merchant } = await newMerchant('bakery');
  const anyone = await reg({ email: 'look@x.com', phone: phone(), username: 'looker' });
  const res = await api('GET', `/merchants/${merchant.slug}`, { token: anyone.token });
  assert.equal(res.status, 200);
  assert.equal(res.json.business_name, 'bakery Shop');
  assert.equal(res.json.user_id, undefined);
  assert.equal(res.json.accepts_payments, true);
});

test('paying an invoice settles it and moves money to the merchant', async () => {
  const { owner, merchant } = await newMerchant('studio');
  const customer = await reg({ email: 'inv1@x.com', phone: phone(), username: 'inv_cust1' });
  await api('POST', '/wallet/topup', { token: customer.token, body: { amount: 100 } });

  const inv = await api('POST', '/invoice/create', {
    token: owner.token, body: { customer_name: 'Jane', amount: 40, description: 'Design work' },
  });
  const id = inv.json.invoice_id;

  const pay = await api('POST', `/invoices/${id}/pay`, { token: customer.token });
  assert.equal(pay.status, 200);
  assert.equal(pay.json.invoice.status, 'paid');
  assert.ok(pay.json.invoice.paid_at);
  assert.equal(pay.json.transaction.type, 'invoice');

  const mWallet = await api('GET', '/wallet', { token: owner.token });
  assert.equal(mWallet.json.balance, 40);

  // Paying twice fails.
  const again = await api('POST', `/invoices/${id}/pay`, { token: customer.token });
  assert.equal(again.status, 409);
});

test('paying an invoice with insufficient funds fails with 402', async () => {
  const { owner, merchant } = await newMerchant('gallery');
  const broke = await reg({ email: 'broke@x.com', phone: phone(), username: 'broke_cust' });
  const inv = await api('POST', '/invoice/create', {
    token: owner.token, body: { customer_name: 'X', amount: 500 },
  });
  const pay = await api('POST', `/invoices/${inv.json.invoice_id}/pay`, { token: broke.token });
  assert.equal(pay.status, 402);
  // Invoice stays open after a failed payment.
  const list = await api('GET', '/invoices', { token: owner.token });
  assert.equal(list.json.invoices.find((i) => i.invoice_id === inv.json.invoice_id).status, 'open');
});

test('a suspended merchant cannot accept payments', async () => {
  const { merchant } = await newMerchant('suspended');
  // Suspend directly in the store.
  const rec = store.find('merchants', (m) => m.slug === merchant.slug);
  store.update('merchants', rec.id, { status: 'suspended' });

  const payer = await reg({ email: 'susp@x.com', phone: phone(), username: 'susp_payer' });
  await api('POST', '/wallet/topup', { token: payer.token, body: { amount: 50 } });
  const pay = await api('POST', `/merchants/${merchant.slug}/pay`, { token: payer.token, body: { amount: 5 } });
  assert.equal(pay.status, 403);

  const lookup = await api('GET', `/merchants/${merchant.slug}`, { token: payer.token });
  assert.equal(lookup.json.accepts_payments, false);
});

test('merchant dashboard aggregates revenue, customers, and invoices', async () => {
  const { owner, merchant } = await newMerchant('bistro');

  const c1 = await reg({ email: 'd1@x.com', phone: phone(), username: 'dash_c1' });
  const c2 = await reg({ email: 'd2@x.com', phone: phone(), username: 'dash_c2' });
  await api('POST', '/wallet/topup', { token: c1.token, body: { amount: 100 } });
  await api('POST', '/wallet/topup', { token: c2.token, body: { amount: 100 } });

  // c1 pays the merchant directly; c2 pays an invoice.
  await api('POST', `/merchants/${merchant.slug}/pay`, { token: c1.token, body: { amount: 20 } });
  const inv = await api('POST', '/invoice/create', {
    token: owner.token, body: { customer_name: 'C2', amount: 30 },
  });
  await api('POST', `/invoices/${inv.json.invoice_id}/pay`, { token: c2.token });
  // An unpaid invoice contributes to outstanding.
  await api('POST', '/invoice/create', { token: owner.token, body: { customer_name: 'Later', amount: 45 } });

  const dash = await api('GET', '/merchant/dashboard', { token: owner.token });
  assert.equal(dash.status, 200);
  assert.equal(dash.json.revenue, 50);
  assert.equal(dash.json.payments_received, 2);
  assert.equal(dash.json.customers, 2);
  assert.equal(dash.json.invoices.total, 2);
  assert.equal(dash.json.invoices.paid, 1);
  assert.equal(dash.json.invoices.open, 1);
  assert.equal(dash.json.invoices.outstanding, 45);
  assert.equal(dash.json.recent_payments.length, 2);
});

test('non-merchant cannot open the dashboard', async () => {
  const nobody = await reg({ email: 'nomerch@x.com', phone: phone(), username: 'no_merch' });
  const res = await api('GET', '/merchant/dashboard', { token: nobody.token });
  assert.equal(res.status, 403);
});
