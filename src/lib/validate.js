import { HttpError } from './http.js';

const SUPPORTED_CURRENCIES = new Set(['EUR']);

export function requireString(body, field, { min = 1, max = 256 } = {}) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new HttpError(400, `Field "${field}" must be a string of ${min}-${max} characters`);
  }
  return value.trim();
}

export function optionalString(body, field, { max = 256 } = {}) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, `Field "${field}" must be a string up to ${max} characters`);
  }
  return value.trim();
}

export function requireEmail(body, field = 'email') {
  const value = requireString(body, field, { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new HttpError(400, `Field "${field}" must be a valid email`);
  }
  return value;
}

// Accepts E.164-ish phone numbers: optional +, 7-15 digits.
export function requirePhone(body, field = 'phone') {
  const value = requireString(body, field, { max: 20 }).replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(value)) {
    throw new HttpError(400, `Field "${field}" must be a valid phone number`);
  }
  return value;
}

// Accepts a number of euros (e.g. 12.5) and returns integer cents. Rejects
// zero, negatives, and sub-cent precision.
export function requireAmountCents(body, field = 'amount') {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `Field "${field}" must be a positive number of euros`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new HttpError(400, `Field "${field}" cannot have sub-cent precision`);
  }
  if (cents > 100_000_00) {
    throw new HttpError(400, `Field "${field}" exceeds the per-transfer limit`);
  }
  return cents;
}

export function normalizeCurrency(body, field = 'currency') {
  const value = (body[field] || 'EUR').toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(value)) {
    throw new HttpError(400, `Currency "${value}" is not supported`);
  }
  return value;
}

export const toEuros = (cents) => Math.round(cents) / 100;
