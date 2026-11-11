import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Store } from '../src/lib/store.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/lib/crypto.js';
import { transfer } from '../src/services/payments.js';

function fixture(t, filesystem = fs) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'euroflow-durable-'));
  const filePath = join(dir, 'state.json');
  const store = new Store({ filePath, filesystem });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.transaction(() => {
    for (const [id, balanceCents] of [['a', 10000], ['b', 0]]) {
      store.insert('users', { id, username: id, firstName: id, lastName: 'Test' });
      store.insert('wallets', { id, userId: id, balanceCents, currency: 'EUR', status: 'active' });
    }
    store.insert('merchants', { id: 'merchant', userId: 'b', status: 'approved' });
    store.insert('invoices', { id: 'invoice', merchantId: 'merchant', amountCents: 2000, currency: 'EUR', status: 'open' });
  });
  return { store, filePath, dir };
}
async function api(t, store) {
  const server = createServer(createApp({ store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${signToken({ sub: 'a' })}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: response.status, body: await response.json() };
  };
}

test('invoice settlement commits balances, transaction, paid marker and notifications in one snapshot', async t => {
  let writes = 0;
  const { store, filePath } = fixture(t, { ...fs, renameSync(...args) { writes++; return fs.renameSync(...args); } });
  const call = await api(t, store);
  writes = 0;
  assert.equal((await call('/invoices/invoice/pay')).status, 200);
  assert.equal(writes, 1);
  const disk = JSON.parse(fs.readFileSync(filePath));
  assert.equal(disk.wallets.a.balanceCents, 8000);
  assert.equal(disk.wallets.b.balanceCents, 2000);
  assert.equal(disk.invoices.invoice.status, 'paid');
  assert.equal(Object.keys(disk.transactions).length, 1);
  assert.equal(Object.keys(disk.notifications).length, 1);
  assert.equal((await call('/invoices/invoice/pay')).status, 409);
});

test('failed snapshot replacement rolls back the whole invoice settlement; retry settles once', async t => {
  let fail = false;
  const { store, filePath, dir } = fixture(t, { ...fs, renameSync(...args) { if (fail) throw new Error('injected disk failure'); return fs.renameSync(...args); } });
  const call = await api(t, store);
  const before = fs.readFileSync(filePath, 'utf8');
  fail = true;
  assert.equal((await call('/invoices/invoice/pay')).status, 500);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(store.get('wallets', 'a').balanceCents, 10000);
  assert.equal(store.get('invoices', 'invoice').status, 'open');
  assert.equal(store.all('transactions').length, 0);
  assert.equal(fs.readdirSync(dir).filter(x => x.endsWith('.tmp')).length, 0);
  fail = false;
  assert.equal((await call('/invoices/invoice/pay')).status, 200);
  assert.equal(store.all('transactions').length, 1);
});

test('concurrent HTTP requests settle the same invoice only once', async t => {
  const { store } = fixture(t);
  const call = await api(t, store);
  const results = await Promise.all(Array.from({ length: 5 }, () => call('/invoices/invoice/pay')));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
  assert.equal(store.get('wallets', 'a').balanceCents, 8000);
  assert.equal(store.get('wallets', 'b').balanceCents, 2000);
});

test('uncertain directory durability after rename poisons the store instead of rolling back and replaying', async t => {
  let syncs = 0, fail = false;
  const { store, filePath } = fixture(t, { ...fs, fsyncSync(fd) {
    syncs++;
    if (fail && syncs % 2 === 0) throw new Error('injected directory fsync failure');
    return fs.fsyncSync(fd);
  } });
  fail = true;
  assert.throws(() => store.update('wallets', 'a', { balanceCents: 9000 }), /directory fsync/);
  assert.equal(JSON.parse(fs.readFileSync(filePath)).wallets.a.balanceCents, 9000);
  assert.throws(() => store.get('wallets', 'a'), /recovery required/);
  assert.throws(() => store.update('wallets', 'a', { balanceCents: 10000 }), /recovery required/);
});

test('corrupt snapshots fail closed and are preserved', t => {
  const { store, filePath } = fixture(t);
  store.close();
  for (const text of ['{truncated', 'null', '{"wallets":[]}', '{"wallets":{"a":{"id":"other"}}}']) {
    fs.writeFileSync(filePath, text);
    assert.throws(() => new Store({ filePath }));
    assert.equal(fs.readFileSync(filePath, 'utf8'), text);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  }
});

test('second process cannot open a live writer; committed snapshot reloads after orderly close', t => {
  const { store, filePath } = fixture(t);
  const script = "import { Store } from './src/lib/store.js'; new Store({filePath: process.argv[1]});";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, filePath], { encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /EEXIST/);
  store.close();
  const reopened = new Store({ filePath });
  assert.equal(reopened.get('wallets', 'a').balanceCents, 10000);
  reopened.close();
});

test('a transaction body exception leaves memory and disk unchanged', t => {
  const { store, filePath } = fixture(t);
  const before = fs.readFileSync(filePath, 'utf8');
  assert.throws(() => store.transaction(() => {
    store.update('wallets', 'a', { balanceCents: 1 });
    throw new Error('aborted');
  }), /aborted/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(store.get('wallets', 'a').balanceCents, 10000);
});

test('production requires configured non-development signing key without exposing its value', () => {
  const run = secret => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/lib/crypto.js')"], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', EUROFLOW_TOKEN_SECRET: secret },
  });
  for (const secret of ['', 'short', 'dev-insecure-secret-change-me', ' '.repeat(40)]) {
    const result = run(secret);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production requires/);
  }
  assert.equal(run('test-only-long-signing-key-not-for-production-12345').status, 0);
});

test('process exit inside a transaction leaves the old snapshot and a fail-closed stale writer lock', t => {
  const { store, filePath } = fixture(t);
  store.close();
  const before = fs.readFileSync(filePath, 'utf8');
  const script = `import { Store } from './src/lib/store.js';
    const s = new Store({filePath: process.argv[1]});
    s.transaction(() => { s.update('wallets', 'a', {balanceCents: 1}); process.exit(77); });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, filePath]);
  assert.equal(child.status, 77);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.throws(() => new Store({ filePath }), /EEXIST/);
  // Simulate deliberate recovery after this child is known to have exited.
  fs.unlinkSync(`${filePath}.lock`);
  const recovered = new Store({ filePath });
  assert.equal(recovered.get('wallets', 'a').balanceCents, 10000);
  recovered.close();
});

test('production cannot self-credit, self-verify or gain admin from an unverified email', () => {
  const script = `import assert from 'node:assert/strict';
    import { Store } from './src/lib/store.js';
    import { register, topUp, verifyKyc } from './src/services/accounts.js';
    const s = new Store();
    const result = s.transaction(() => register(s, {first_name:'Demo',last_name:'User',email:'admin@example.test',phone:'+351911111111',country:'PT',username:'demo',password:'test-pass-123'}));
    assert.equal(result.user.is_admin, false);
    assert.throws(() => topUp(s, result.user.user_id, 100), /unavailable in production/);
    assert.throws(() => verifyKyc(s, result.user.user_id), /unavailable in production/);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', EUROFLOW_ADMIN_EMAILS: 'admin@example.test', EUROFLOW_TOKEN_SECRET: 'test-only-long-key-not-for-deployment-123456' } });
  assert.equal(child.status, 0, child.stderr);
});

test('split details require participant or creator membership', async t => {
  const { store } = fixture(t);
  store.insert('splitGroups', { id: 'private', creatorId: 'b', name: 'Private dinner' });
  const server = createServer(createApp({ store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = id => fetch(`http://127.0.0.1:${server.address().port}/splits/private`, { headers: { Authorization: `Bearer ${signToken({ sub: id })}` } });
  assert.equal((await get('a')).status, 404);
  assert.equal((await get('b')).status, 200);
  store.insert('splitParticipants', { groupId: 'private', userId: 'a', amountCents: 100, status: 'pending' });
  assert.equal((await get('a')).status, 200);
});

test('top-up rejects nonnumeric and sub-cent amounts without corrupting the snapshot', async t => {
  const { store } = fixture(t);
  const server = createServer(createApp({ store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const amount of ['not money', 0.001, '10', 100001]) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/wallet/topup`, {
      method: 'POST', headers: { Authorization: `Bearer ${signToken({ sub: 'a' })}`, 'Content-Type': 'application/json' }, body: JSON.stringify({amount}),
    });
    assert.equal(result.status, 400);
  }
  assert.equal(store.get('wallets', 'a').balanceCents, 10000);
});

test('direct ledger transfer rolls back an error between debit and credit', t => {
  const { store, filePath } = fixture(t);
  const before = fs.readFileSync(filePath, 'utf8');
  const update = store.update.bind(store);
  store.update = (collection, id, patch) => {
    if (collection === 'wallets' && id === 'b') throw new Error('injected credit failure');
    return update(collection, id, patch);
  };
  assert.throws(() => transfer(store, { senderUserId: 'a', receiverUserId: 'b', amountCents: 1000, currency: 'EUR' }), /credit failure/);
  assert.equal(store.get('wallets', 'a').balanceCents, 10000);
  assert.equal(store.get('wallets', 'b').balanceCents, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('unsupported asynchronous backends fail closed instead of losing writes', () => {
  assert.throws(() => new Store({ backend: { onMutation() {} } }), /Pluggable persistence is unavailable/);
});

test('standalone removal is durable and releases the writer lock on close', t => {
  const {store, filePath} = fixture(t);
  store.remove('users', 'a');
  assert.equal(JSON.parse(fs.readFileSync(filePath)).users.a, undefined);
  store.close();
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
  const reopened = new Store({filePath});
  assert.equal(reopened.get('users', 'a'), null);
  reopened.close();
});

test('database-configured startup refuses to silently use a demo file', () => {
  const result = spawnSync(process.execPath, ['src/server.js'], {
    encoding: 'utf8', timeout: 5000,
    env: {...process.env, DATABASE_URL: 'postgres://not-used.invalid/demo'},
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Postgres persistence is not release-ready/);
});
