import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Durable backend that snapshots the whole dataset to a JSON file on every
// mutation and reloads it at startup. This reproduces EuroFlow's original
// file-persistence behavior behind the pluggable backend interface.
export class FileBackend {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async loadAll() {
    if (!this.filePath || !existsSync(this.filePath)) return null;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      // Corrupt file: start clean rather than crashing the server.
      return null;
    }
  }

  onMutation({ store }) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store.data, null, 2));
  }

  async flush() { /* writes are synchronous, already durable */ }

  async close() { /* nothing to release */ }
}
