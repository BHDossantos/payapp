import { createServer } from 'node:http';
import { Store } from './lib/store.js';
import { createApp } from './app.js';
import { runDue } from './services/scheduled.js';
import { FileBackend } from './lib/persistence/file-backend.js';
import { PostgresBackend } from './lib/persistence/postgres-backend.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.EUROFLOW_DATA_FILE || new URL('../data/euroflow.json', import.meta.url).pathname;
const SCHEDULE_TICK_MS = Number(process.env.EUROFLOW_SCHEDULE_TICK_MS || 60_000);
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

// Durability backend selection:
//   DATABASE_URL set  -> Postgres (e.g. Supabase), the system of record
//   otherwise         -> JSON file snapshot (zero-dependency default)
let backend;
if (process.env.DATABASE_URL) {
  backend = new PostgresBackend({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.EUROFLOW_PG_SCHEMA || 'euroflow',
  });
} else {
  backend = new FileBackend(DATA_FILE);
}

const store = new Store({ backend });
await store.init();

const handler = createApp({ store, staticDir: PUBLIC_DIR });
const server = createServer(handler);

server.listen(PORT, () => {
  console.log(`EuroFlow API listening on http://localhost:${PORT}`);
  console.log(`Persistence: ${process.env.DATABASE_URL ? 'Postgres' : `file (${DATA_FILE})`}`);
});

// Periodically fire any due recurring requests. unref() so the timer never keeps
// the process alive on its own.
const scheduleTimer = setInterval(() => {
  try {
    const { ran } = runDue(store);
    if (ran > 0) console.log(`Generated ${ran} scheduled request(s)`);
  } catch (err) {
    console.error('Schedule run failed:', err);
  }
}, SCHEDULE_TICK_MS);
scheduleTimer.unref();

// Flush and release durable state on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    try {
      await store.close();
    } finally {
      server.close(() => process.exit(0));
    }
  });
}
