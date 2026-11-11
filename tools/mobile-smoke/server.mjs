import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/lib/store.js';
import { createApp } from '../../src/app.js';

// Fresh in-memory demo ledger. Never reads or writes the developer's persisted data.
const server = createServer(createApp({
  store: new Store(),
  staticDir: fileURLToPath(new URL('../../public', import.meta.url)),
}));
server.listen(4174, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
