# EuroFlow — The Unified European Money Network

> One app to move money instantly across Europe — by phone number, username,
> email, or QR code — for people **and** businesses.

This repository contains the **MVP backend API** (the "experience layer" from
the product brief). It deliberately models the wallet, payments, requests,
bill-splitting, merchant and invoicing flows on top of an internal ledger, so
the same API can later sit in front of real rails (SEPA Instant via a provider
like Stripe Treasury, Adyen, TrueLayer or Tink) instead of becoming a bank.

## Design goals

- **Zero runtime dependencies.** Built entirely on the Node.js standard library
  (`http`, `crypto`, `url`). It runs anywhere Node ≥ 20 is installed — no
  `npm install`, no native modules, no network access required.
- **Correct money handling.** All balances and amounts are stored as **integer
  cents**; euros only appear at the API boundary. No floating-point drift.
- **Honest auth.** Passwords are hashed with `scrypt` + per-user salt; sessions
  are stateless HMAC-signed tokens.
- **Swappable persistence.** An in-memory document store with optional JSON-file
  persistence. The `Store` is the single seam to replace with Postgres later.

## Quick start

```bash
node src/server.js          # starts on http://localhost:3000
# or
npm start
```

Then open **http://localhost:3000/** in a browser: the server also serves a
zero-build **web client** (the consumer + business screens from the brief) from
`public/`, talking to the same JSON API. Sign up, top up play funds, and try
sending, requesting, splitting, and the merchant/invoice/QR flows end to end.

Run the test suite (Node's built-in runner, no deps):

```bash
npm test                    # node --test
```

### Configuration (environment variables)

| Variable                 | Default                     | Purpose                              |
| ------------------------ | --------------------------- | ------------------------------------ |
| `PORT`                   | `3000`                      | HTTP port                            |
| `EUROFLOW_DATA_FILE`     | `./data/euroflow.json`      | JSON persistence path                |
| `EUROFLOW_TOKEN_SECRET`  | `dev-insecure-secret...`    | HMAC secret for session tokens       |
| `EUROFLOW_PAY_URL`       | `https://euroflow.app/pay`  | Base URL for payment links / QR      |

> ⚠️ Always set a strong `EUROFLOW_TOKEN_SECRET` outside local development.

## Authentication

`POST /auth/register` and `POST /auth/login` return a `token`. Send it on every
protected route as a header:

```
Authorization: Bearer <token>
```

## API reference

All request/response bodies are JSON. Amounts in requests are **euros**
(e.g. `30.50`); responses include both `amount` (euros) and, for wallets,
`balance_cents`.

### Auth & profile

| Method & path        | Auth | Body / notes                                                                 |
| -------------------- | ---- | --------------------------------------------------------------------------- |
| `POST /auth/register`| no   | `first_name, last_name, email, phone, country (ISO-2), password (≥8)`, optional `username` (3–30: `a-z0-9_.`) |
| `POST /auth/login`   | no   | `password` + one of `email` / `phone` / `username`                          |
| `GET /me`            | yes  | Current user + wallet                                                        |
| `POST /kyc/verify`   | yes  | Stub that flips `kyc_status` to `verified`                                   |

### Wallet & payments

| Method & path            | Auth | Body / notes                                                              |
| ------------------------ | ---- | ------------------------------------------------------------------------ |
| `GET /wallet`            | yes  | Balance, currency, status                                                |
| `POST /wallet/topup`     | yes  | `amount` — demo credit standing in for a provider top-up                 |
| `POST /wallet/send`      | yes  | `amount`, optional `note`, plus a recipient handle (`username`/`email`/`phone`) |
| `GET /wallet/history`    | yes  | Optional `?status=` and `?direction=sent\|received`                      |
| `GET /transactions`      | yes  | Alias of `/wallet/history`                                               |

A send with insufficient funds returns **402** and records a `failed`
transaction; you cannot send money to yourself.

### Payment requests

| Method & path                        | Auth | Notes                                            |
| ------------------------------------ | ---- | ------------------------------------------------ |
| `POST /wallet/request`               | yes  | `amount`, optional `reason`, + recipient handle  |
| `GET /wallet/requests?box=incoming`  | yes  | `incoming` (default) or `outgoing`               |
| `POST /wallet/requests/:id/pay`      | yes  | Settles the request via a real transfer          |
| `POST /wallet/requests/:id/decline`  | yes  | Declines a pending request                       |

### Bill splitting

| Method & path            | Auth | Notes                                                                       |
| ------------------------ | ---- | --------------------------------------------------------------------------- |
| `POST /wallet/split`     | yes  | `name`, `participants[]` (each a handle). Either per-participant `amount`, or `split:"equal"` + `total` to divide evenly |
| `GET /splits`            | yes  | Splits you created or are part of                                           |
| `GET /splits/:id`        | yes  | Group detail with per-participant status                                    |
| `POST /splits/:id/pay`   | yes  | Pay your share to the group creator                                         |

The creator's own share is auto-settled (they collect rather than pay).

### Merchant & business

| Method & path             | Auth | Notes                                                          |
| ------------------------- | ---- | -------------------------------------------------------------- |
| `POST /merchant/register` | yes  | `business_name`, `country`, optional `vat_number`. Creates a unique payment-link slug, status `pending` (awaits KYB) |
| `GET /merchant`           | yes  | Your merchant profile + payment link                          |
| `POST /invoice/create`    | yes  | `customer_name`, `amount`, optional `description`, `due_date`  |
| `GET /invoices`           | yes  | Invoices issued by your merchant profile                       |
| `POST /invoices/:id/paid` | yes  | Mark an invoice paid                                           |
| `POST /qr/generate`       | yes  | `type`: `p2p` \| `merchant` \| `dynamic`. Returns a `euroflow://pay?…` deep link + web link for the client to render |

## Project layout

```
src/
  server.js            # HTTP server bootstrap + graceful shutdown
  app.js               # route table, auth middleware, error handling
  lib/
    http.js            # tiny router, JSON helpers, HttpError
    crypto.js          # scrypt password hashing + HMAC session tokens
    store.js           # in-memory document store w/ JSON persistence
    static.js          # static file serving for the web client (traversal-safe)
    validate.js        # input validation + euro<->cents helpers
  services/
    accounts.js        # register / login / wallets / KYC
    payments.js        # the core ledger transfer + history
    requests.js        # request money
    splits.js          # bill splitting
    business.js        # merchants, invoices, payment links, QR
public/
  index.html           # web client shell (SPA)
  styles.css           # styling
  app.js               # client logic (vanilla ES modules, no build step)
test/
  api.test.js          # end-to-end API tests (node --test)
```

## Example: end-to-end P2P transfer

```bash
# 1. Register two users (each returns a token)
curl -s localhost:3000/auth/register -d '{"first_name":"Ana","last_name":"R","email":"ana@x.eu","phone":"+351911111111","country":"PT","username":"ana","password":"supersecret"}' -H 'Content-Type: application/json'
curl -s localhost:3000/auth/register -d '{"first_name":"Luca","last_name":"B","email":"luca@x.eu","phone":"+393331111111","country":"IT","username":"luca","password":"supersecret"}' -H 'Content-Type: application/json'

# 2. Top up Ana, then send €10 to Luca in Rome
TOKEN=...   # Ana's token
curl -s localhost:3000/wallet/topup -H "Authorization: Bearer $TOKEN" -d '{"amount":50}' -H 'Content-Type: application/json'
curl -s localhost:3000/wallet/send  -H "Authorization: Bearer $TOKEN" -d '{"username":"luca","amount":10,"note":"Pizza"}' -H 'Content-Type: application/json'
```

## What this MVP is *not* (yet)

The brief's "critical reality check" applies: the genuinely hard parts —
licensing, KYC/AML at scale, PSD2/SCA, fund safeguarding, and real banking
integrations — are intentionally **out of scope** here. `topup` and `kyc/verify`
are stubs that represent where a regulated provider would plug in. This codebase
is the product/experience layer you would put *in front of* that infrastructure.

## License

MIT
