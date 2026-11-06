import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname } from 'node:path';

// A tiny document store. Everything lives in memory for speed; when a file path
// is provided it is also persisted to disk as JSON so data survives restarts.
// Monetary values are stored as integer minor units (cents) everywhere.
export class Store {
  constructor({ filePath = null, filesystem = fs } = {}) {
    this.fs = filesystem;
    this.inTransaction = false;
    this.closed = false;
    this.poisoned = false;
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
      notifications: {},
      scheduledRequests: {},
      contacts: {},
    };
    if (filePath) {
      this.fs.mkdirSync(dirname(filePath), { recursive: true });
      this.lockPath = `${filePath}.lock`;
      // Never steal a lock by PID/age: a paused or remote writer may still live.
      this.lockFd = this.fs.openSync(this.lockPath, 'wx', 0o600);
      try {
        if (this.fs.existsSync(filePath)) {
          const loaded = JSON.parse(this.fs.readFileSync(filePath, 'utf8'));
          if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
            throw new Error('Invalid store snapshot');
          }
          for (const [name, rows] of Object.entries(loaded)) {
            if (!Object.hasOwn(this.data, name) || !rows || typeof rows !== 'object' || Array.isArray(rows)) {
              throw new Error('Invalid store collection');
            }
            for (const [id, row] of Object.entries(rows)) {
              if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== id) {
                throw new Error('Invalid store record');
              }
            }
          }
          this.data = { ...this.data, ...loaded };
        }
      } catch (error) {
        this.close();
        throw error; // Preserve the file; never silently replace it with empty balances.
      }
    }
  }

  assertUsable() {
    if (this.closed || this.poisoned) throw new Error('Store unavailable; operator recovery required');
  }

  // Only synchronous, in-process operations are supported. No provider I/O belongs
  // inside this transaction. HTTP handlers and scheduled runs commit as one unit.
  transaction(work) {
    this.assertUsable();
    if (work.constructor.name === 'AsyncFunction') throw new Error('Async transactions are unsupported');
    if (this.inTransaction) return work();
    const previous = this.data;
    this.data = structuredClone(previous);
    this.inTransaction = true;
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw new Error('Async transactions are unsupported');
      this.inTransaction = false;
      this.persist();
      return result;
    } catch (error) {
      // A directory fsync failure after rename has an uncertain durable outcome.
      // Retain the new memory image, poison the store and require recovery.
      if (!this.poisoned) this.data = previous;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  persist() {
    this.assertUsable();
    if (!this.filePath || this.inTransaction) return;
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd;
    let renamed = false;
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600);
      this.fs.writeFileSync(fd, JSON.stringify(this.data, null, 2));
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temp, this.filePath);
      renamed = true;
      const dirFd = this.fs.openSync(dirname(this.filePath), 'r');
      try { this.fs.fsyncSync(dirFd); } finally { this.fs.closeSync(dirFd); }
    } catch (error) {
      if (renamed) this.poisoned = true;
      throw error;
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (!renamed && this.fs.existsSync(temp)) this.fs.unlinkSync(temp);
    }
  }

  close() {
    this.closed = true;
    if (this.lockFd !== undefined) {
      this.fs.closeSync(this.lockFd);
      this.lockFd = undefined;
      this.fs.unlinkSync(this.lockPath);
    }
  }

  // --- generic helpers ---
  insert(collection, doc) {
    if (!this.inTransaction) return this.transaction(() => this.insert(collection, doc));
    const id = doc.id || randomUUID();
    const record = { id, ...doc };
    this.data[collection][id] = record;
    this.persist();
    return record;
  }

  get(collection, id) {
    this.assertUsable();
    return this.data[collection][id] || null;
  }

  update(collection, id, patch) {
    if (!this.inTransaction) return this.transaction(() => this.update(collection, id, patch));
    const existing = this.data[collection][id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.data[collection][id] = updated;
    this.persist();
    return updated;
  }

  all(collection) {
    this.assertUsable();
    return Object.values(this.data[collection]);
  }

  find(collection, predicate) {
    return this.all(collection).find(predicate) || null;
  }

  filter(collection, predicate) {
    return this.all(collection).filter(predicate);
  }
}
