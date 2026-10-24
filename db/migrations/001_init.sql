-- EuroFlow Postgres persistence schema.
-- The application also creates these objects automatically on first connect
-- (see src/lib/persistence/postgres-backend.js); this file documents the schema
-- and lets you provision it explicitly (e.g. via Supabase migrations).
--
-- Override the schema name with EUROFLOW_PG_SCHEMA (default: euroflow).

create schema if not exists euroflow;

-- One row per domain record. `collection` is the entity type (users, wallets,
-- transactions, …) and `doc` is the record as JSONB. The in-memory Store is the
-- read path; this table is the durable system of record.
create table if not exists euroflow.documents (
  collection  text        not null,
  id          text        not null,
  doc         jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

-- Helpful for ad-hoc inspection / analytics by entity type.
create index if not exists documents_collection_idx on euroflow.documents (collection);
