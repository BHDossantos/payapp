import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/lib/store.js';
import { PostgresBackend } from '../src/lib/persistence/postgres-backend.js';

// Integration test for the Postgres backend. It is skipped unless DATABASE_URL
// is set (so CI and local runs without a database stay green), and it uses an
// isolated schema so it never touches real application data.
//
//   DATABASE_URL=postgres://... EUROFLOW_PG_SCHEMA=euroflow_test node --test
const url = process.env.DATABASE_URL;
const schema = process.env.EUROFLOW_PG_SCHEMA || 'euroflow_test';

test('Postgres backend persists and reloads records', { skip: url ? false : 'DATABASE_URL not set' }, async () => {
  // --- write through one store instance ---
  const b1 = new PostgresBackend({ connectionString: url, schema });
  const s1 = new Store({ backend: b1 });
  await s1.init();

  const unique = `pg-${Date.now()}@test.eu`;
  const user = s1.insert('users', { email: unique, firstName: 'Pg', lastName: 'Tester' });
  s1.update('users', user.id, { firstName: 'Pg2' });
  const temp = s1.insert('users', { email: `tmp-${Date.now()}@test.eu`, firstName: 'Temp' });
  s1.remove('users', temp.id);
  await s1.flush();
  await b1.close();

  // --- reload with a fresh store/backend: data must survive ---
  const b2 = new PostgresBackend({ connectionString: url, schema });
  const s2 = new Store({ backend: b2 });
  await s2.init();

  const reloaded = s2.get('users', user.id);
  assert.ok(reloaded, 'user should have been reloaded from Postgres');
  assert.equal(reloaded.firstName, 'Pg2', 'update should have been persisted');
  assert.equal(s2.get('users', temp.id), null, 'removed record should not reload');

  // cleanup
  s2.remove('users', user.id);
  await s2.flush();
  await b2.close();
});
