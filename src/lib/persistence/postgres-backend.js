// Durable backend that persists each record as a row in a Postgres JSONB
// `documents` table and reloads the whole set at startup. The in-memory Store
// remains the read path; this backend is the system of record.
//
// `pg` is imported lazily so the zero-dependency in-memory/file builds never
// need it — only a process that actually sets DATABASE_URL pulls it in.
//
// Writes are serialized through a promise queue and applied as the record
// changes, so repeated calls are safe and ordered. Call flush() to await
// pending writes and close() on shutdown.
export class PostgresBackend {
  constructor({ connectionString, schema = 'euroflow' }) {
    if (!connectionString) throw new Error('PostgresBackend requires a connectionString');
    // Guard the schema identifier: it is interpolated into DDL, never parameterized.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      throw new Error(`Invalid Postgres schema name: ${schema}`);
    }
    this.connectionString = connectionString;
    this.schema = schema;
    this.pool = null;
    this.queue = Promise.resolve();
  }

  table() {
    return `"${this.schema}".documents`;
  }

  async _pool() {
    if (!this.pool) {
      const mod = await import('pg');
      const { Pool } = mod.default ?? mod;
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    }
    return this.pool;
  }

  async _ensureSchema(pool) {
    await pool.query(`create schema if not exists "${this.schema}"`);
    await pool.query(`create table if not exists ${this.table()} (
      collection text not null,
      id text not null,
      doc jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (collection, id)
    )`);
  }

  async loadAll() {
    const pool = await this._pool();
    await this._ensureSchema(pool);
    const { rows } = await pool.query(`select collection, id, doc from ${this.table()}`);
    const data = {};
    for (const row of rows) {
      (data[row.collection] ||= {})[row.id] = row.doc;
    }
    return data;
  }

  onMutation({ op, collection, id, record }) {
    this._enqueue(async (pool) => {
      if (op === 'remove') {
        await pool.query(`delete from ${this.table()} where collection = $1 and id = $2`, [collection, id]);
      } else {
        await pool.query(
          `insert into ${this.table()} (collection, id, doc, updated_at)
           values ($1, $2, $3::jsonb, now())
           on conflict (collection, id) do update set doc = excluded.doc, updated_at = now()`,
          [collection, id, JSON.stringify(record)],
        );
      }
    });
  }

  _enqueue(fn) {
    this.queue = this.queue.then(async () => {
      try {
        const pool = await this._pool();
        await fn(pool);
      } catch (err) {
        // Never throw into the caller's synchronous mutation path; surface loudly.
        console.error('Postgres persistence error:', err.message);
      }
    });
    return this.queue;
  }

  async flush() {
    await this.queue;
  }

  async close() {
    await this.flush();
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
