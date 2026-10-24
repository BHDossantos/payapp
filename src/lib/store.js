import { randomUUID } from 'node:crypto';

// A tiny document store. Everything lives in memory for fast, synchronous reads
// and predicate scans. Durability is delegated to an optional pluggable backend
// (file snapshot or Postgres write-through); with no backend the store is purely
// in-memory, which is what the test suite uses. Monetary values are stored as
// integer minor units (cents) everywhere.
const EMPTY = () => ({
  users: {},
  wallets: {},
  transactions: {},
  paymentRequests: {},
  splitGroups: {},
  splitParticipants: {},
  merchants: {},
  invoices: {},
  qrCodes: {},
  notifications: {},
  scheduledRequests: {},
  contacts: {},
});

export class Store {
  constructor({ backend = null } = {}) {
    this.backend = backend;
    this.data = EMPTY();
  }

  // Loads any persisted state from the backend into memory. Safe to call once at
  // startup; a no-op when there is no backend (in-memory mode).
  async init() {
    if (this.backend?.loadAll) {
      const loaded = await this.backend.loadAll();
      if (loaded) {
        for (const [collection, rows] of Object.entries(loaded)) {
          // Only merge known collections so a stale backend row can't inject one.
          if (this.data[collection]) this.data[collection] = { ...this.data[collection], ...rows };
        }
      }
    }
    return this;
  }

  _emit(op, collection, id, record) {
    this.backend?.onMutation?.({ store: this, op, collection, id, record });
  }

  // --- generic helpers ---
  insert(collection, doc) {
    const id = doc.id || randomUUID();
    const record = { id, ...doc };
    this.data[collection][id] = record;
    this._emit('upsert', collection, id, record);
    return record;
  }

  get(collection, id) {
    return this.data[collection][id] || null;
  }

  update(collection, id, patch) {
    const existing = this.data[collection][id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.data[collection][id] = updated;
    this._emit('upsert', collection, id, updated);
    return updated;
  }

  remove(collection, id) {
    const existing = this.data[collection][id];
    if (!existing) return null;
    delete this.data[collection][id];
    this._emit('remove', collection, id, existing);
    return existing;
  }

  all(collection) {
    return Object.values(this.data[collection]);
  }

  find(collection, predicate) {
    return this.all(collection).find(predicate) || null;
  }

  filter(collection, predicate) {
    return this.all(collection).filter(predicate);
  }

  // Awaits any pending durable writes (meaningful for async backends).
  async flush() {
    await this.backend?.flush?.();
  }

  async close() {
    await this.backend?.close?.();
  }
}
