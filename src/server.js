import { createServer } from 'node:http';
import { Store } from './lib/store.js';
import { createApp } from './app.js';
import { runDue } from './services/scheduled.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.EUROFLOW_DATA_FILE || new URL('../data/euroflow.json', import.meta.url).pathname;
const SCHEDULE_TICK_MS = Number(process.env.EUROFLOW_SCHEDULE_TICK_MS || 60_000);

const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

const store = new Store({ filePath: DATA_FILE });
const handler = createApp({ store, staticDir: PUBLIC_DIR });
const server = createServer(handler);

server.listen(PORT, () => {
  console.log(`EuroFlow API listening on http://localhost:${PORT}`);
  console.log(`Persisting to ${DATA_FILE}`);
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

// Flush state on shutdown so nothing in memory is lost.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.persist();
    server.close(() => process.exit(0));
  });
}
