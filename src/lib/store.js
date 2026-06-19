import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// A tiny document store. Everything lives in memory for speed; when a file path
// is provided it is also persisted to disk as JSON so data survives restarts.
// Monetary values are stored as integer minor units (cents) everywhere.
export class Store {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.data = {
      users: {},
      wallets: {},
      transactions: {},
      paymentRequests: {},
      splitGroups: {},
      splitParticipants: {},
      merchants: {},
      invoices: {},
      qrCodes: {},
    };
    if (filePath && existsSync(filePath)) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        // Corrupt file: start clean rather than crashing the server.
      }
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // --- generic helpers ---
  insert(collection, doc) {
    const id = doc.id || randomUUID();
    const record = { id, ...doc };
    this.data[collection][id] = record;
    this.persist();
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
    this.persist();
    return updated;
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
}
