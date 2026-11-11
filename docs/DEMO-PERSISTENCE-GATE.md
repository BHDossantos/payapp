# Demo persistence gate — November 11, 2026

The merged PostgreSQL and ledger-safety branches left missing `_emit` and `init` methods and a duplicate `close` overriding writer-lock cleanup. This repair restores guarded file-store demo operation and rejects a configured asynchronous backend or DATABASE_URL explicitly. It never substitutes a fresh local ledger for an existing database.

The PostgreSQL implementation queues individual record writes and logs rather than propagates failures. It cannot currently guarantee atomic ledger transactions or acknowledgement after durable commit. PostgreSQL mode remains blocked until those semantics and crash/failure tests are implemented. The existing database integration test remains present; it is skipped when no database is supplied, not counted as passed.

This is a simulated-money demo repair, not permission or readiness for real payments, production deployment, or mobile-store publication. No production database or deployment setting was changed.
