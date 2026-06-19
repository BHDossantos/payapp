import { createServer } from 'node:http';
import { Store } from './lib/store.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.EUROFLOW_DATA_FILE || new URL('../data/euroflow.json', import.meta.url).pathname;

const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

const store = new Store({ filePath: DATA_FILE });
const handler = createApp({ store, staticDir: PUBLIC_DIR });
const server = createServer(handler);

server.listen(PORT, () => {
  console.log(`EuroFlow API listening on http://localhost:${PORT}`);
  console.log(`Persisting to ${DATA_FILE}`);
});

// Flush state on shutdown so nothing in memory is lost.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.persist();
    server.close(() => process.exit(0));
  });
}
