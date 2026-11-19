import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTransactions } from '../public/history.js';
const rows = [{ direction: 'sent', receiver_name: 'Alice', reference: 'Rent', amount: 42, status: 'completed' }, { direction: 'received', sender_name: 'Bob', reference: null, amount: 10, status: 'pending' }];
test('searches names, notes, amounts and statuses without changing source records', () => {
  for (const q of [' alice ', 'RENT', '42']) assert.deepEqual(filterTransactions(rows, q), [rows[0]]);
  assert.deepEqual(filterTransactions(rows, 'pending'), [rows[1]]);
  assert.deepEqual(filterTransactions(rows, '', 'received'), [rows[1]]);
  assert.deepEqual(filterTransactions(rows, 'Alice', 'received'), []);
  assert.deepEqual(filterTransactions(rows, 'missing'), []);
  assert.equal(filterTransactions(rows).length, 2);
  assert.equal(rows.length, 2);
});
