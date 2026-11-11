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

test('sync flags which contacts are already on EuroFlow', async () => {
  const me = await reg({ email: 'cme@x.com', phone: '+351960000001', username: 'c_me' });
  await reg({ email: 'friend@x.com', phone: '+351960000002', username: 'c_friend', first_name: 'Fran', last_name: ' Friend' });
  await reg({ email: 'byemail@x.com', phone: '+351960000003', username: 'c_email' });

  const res = await api('POST', '/contacts/sync', {
    token: me.token,
    body: {
      contacts: [
        { name: 'Fran', phone: '+351 960 000 002' }, // matches by phone (note spaces)
        { name: 'Email Match', email: 'ByEmail@x.com' }, // matches by email (case-insensitive)
        { name: 'Not On App', phone: '+351999888777' }, // no match
        { name: 'No handle' }, // skipped (no phone/email)
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.added, 3);
  assert.equal(res.json.skipped, 1);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.on_platform.length, 2);

  const onApp = await api('GET', '/contacts?on_platform=true', { token: me.token });
  assert.equal(onApp.json.contacts.length, 2);
  assert.ok(onApp.json.contacts.every((c) => c.on_platform && c.user));
});

test('membership resolves live when a contact joins later', async () => {
  const me = await reg({ email: 'live@x.com', phone: '+351961000001', username: 'c_live' });
  await api('POST', '/contacts/sync', {
    token: me.token, body: { contacts: [{ name: 'Future User', phone: '+351961000099' }] },
  });
  let list = await api('GET', '/contacts', { token: me.token });
  assert.equal(list.json.contacts[0].on_platform, false);

  // That person now signs up with the same phone.
  await reg({ email: 'future@x.com', phone: '+351961000099', username: 'c_future' });

  list = await api('GET', '/contacts', { token: me.token });
  const c = list.json.contacts.find((x) => x.phone === '+351961000099');
  assert.equal(c.on_platform, true);
  assert.equal(c.user.username, 'c_future');
});

test('re-syncing updates rather than duplicating', async () => {
  const me = await reg({ email: 'dup@x.com', phone: '+351962000001', username: 'c_dup' });
  const body = { contacts: [{ name: 'Alex', phone: '+351962000050' }] };
  await api('POST', '/contacts/sync', { token: me.token, body });
  const second = await api('POST', '/contacts/sync', {
    token: me.token, body: { contacts: [{ name: 'Alex Updated', phone: '+351962000050' }] },
  });
  assert.equal(second.json.added, 0);
  assert.equal(second.json.updated, 1);
  assert.equal(second.json.total, 1);
});

test('directory search: username prefix, exact email/phone, excludes caller', async () => {
  const me = await reg({ email: 'search@x.com', phone: '+351963000001', username: 'searcher' });
  await reg({ email: 'luca@x.com', phone: '+351963000002', username: 'luca_rome', first_name: 'Luca', last_name: 'Rossi' });

  const byUser = await api('GET', '/users/search?q=luca', { token: me.token });
  assert.ok(byUser.json.results.some((r) => r.username === 'luca_rome'));
  assert.ok(byUser.json.results.every((r) => !r.email)); // no PII leaked

  const byEmail = await api('GET', '/users/search?q=luca@x.com', { token: me.token });
  assert.equal(byEmail.json.results.length, 1);
  assert.equal(byEmail.json.results[0].username, 'luca_rome');

  const byPhone = await api('GET', '/users/search?q=+351963000002', { token: me.token });
  assert.equal(byPhone.json.results.length, 1);

  // Searching my own name should not return me.
  const self = await api('GET', '/users/search?q=searcher', { token: me.token });
  assert.ok(!self.json.results.some((r) => r.username === 'searcher'));

  // Too-short query is rejected.
  const short = await api('GET', '/users/search?q=a', { token: me.token });
  assert.equal(short.status, 400);
});

test('delete a contact', async () => {
  const me = await reg({ email: 'del@x.com', phone: '+351964000001', username: 'c_del' });
  await api('POST', '/contacts/sync', { token: me.token, body: { contacts: [{ name: 'Temp', email: 'temp@x.com' }] } });
  let list = await api('GET', '/contacts', { token: me.token });
  const id = list.json.contacts[0].contact_id;

  const del = await api('DELETE', `/contacts/${id}`, { token: me.token });
  assert.equal(del.status, 200);
  list = await api('GET', '/contacts', { token: me.token });
  assert.equal(list.json.contacts.length, 0);

  const again = await api('DELETE', `/contacts/${id}`, { token: me.token });
  assert.equal(again.status, 404);
});

test('sync validation and invite text', async () => {
  const me = await reg({ email: 'inv@x.com', phone: '+351965000001', username: 'c_inv' });
  const bad = await api('POST', '/contacts/sync', { token: me.token, body: {} });
  assert.equal(bad.status, 400);

  const invite = await api('POST', '/contacts/invite', { token: me.token, body: { name: 'Sam' } });
  assert.equal(invite.status, 200);
  assert.match(invite.json.message, /EuroFlow/);
  assert.match(invite.json.link, /ref=c_inv/);
});
