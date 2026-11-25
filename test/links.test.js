import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBaseUrl, joinUrl } from '../src/lib/links.js';

test('pay links never default to a domain we do not own', () => {
  const saved = process.env.EUROFLOW_PAY_URL;
  delete process.env.EUROFLOW_PAY_URL;
  try {
    assert.doesNotMatch(payBaseUrl(), /euroflow\.app/);
    assert.equal(joinUrl('ana'), `${new URL('../join', payBaseUrl() + '/').origin}/join?ref=ana`);
  } finally {
    if (saved !== undefined) process.env.EUROFLOW_PAY_URL = saved;
  }
});

test('invite link is a clean URL next to /pay', () => {
  const saved = process.env.EUROFLOW_PAY_URL;
  process.env.EUROFLOW_PAY_URL = 'https://pay.example.com/pay/';
  try {
    assert.equal(payBaseUrl(), 'https://pay.example.com/pay');
    assert.equal(joinUrl('ana b'), 'https://pay.example.com/join?ref=ana+b');
  } finally {
    if (saved === undefined) delete process.env.EUROFLOW_PAY_URL; else process.env.EUROFLOW_PAY_URL = saved;
  }
});
