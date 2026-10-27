# Mobile readiness audit (2026-10-21)

## Verdict

The active `claude/upbeat-fermat-b4s6fj` branch is EuroFlow's Node demo-ledger API and vanilla browser client, not a native mobile app. Its existing 47 API tests pass locally; historical CI passed at `c360f603153afd6366f4c3ed3e4fbdb93355f20c` ([run](https://github.com/BHDossantos/payapp/actions/runs/33766756189)).

The separate `mobile/euroflow-foundation` branch adds only `mobile/package.json` and `mobile/app.json`: there are no Expo routes/screens, no lockfile, no EAS profiles and no integrated client. A manifest alone is not an application. Jennifer provides a real Expo reference, but its code, signing identity and financial assumptions must not be copied wholesale.

## Automation added

`.github/workflows/mobile-web.yml` runs isolated Playwright checks for Android Chrome and iPhone Safari browser profiles:

- Login/account-creation forms at phone width, including interrupted registration.
- Fresh synthetic registration, authenticated navigation, refresh/session restoration and logout.
- Horizontal-overflow assertions, failure screenshots/traces and HTML report retention.

The test server is bound to localhost and uses a new in-memory `Store`; it never reads/writes the persisted demo data or calls a payment service. There are no real-money operations. Test tooling lives under `tools/mobile-smoke` with its own pinned dependency/lockfile, preserving the API's zero-runtime-dependency design.

These are mobile-browser tests, not a native build pipeline or regulated-finance certification.

## Run locally

```sh
npm test
npm ci --prefix tools/mobile-smoke
npx --prefix tools/mobile-smoke playwright install --with-deps chromium webkit
npm --prefix tools/mobile-smoke test
```

A preinstalled Chromium can be selected with `MOBILE_CHROMIUM_EXECUTABLE` and `--project android-chromium`. The fixture server refuses to reuse another running instance.

## Remaining release gates

1. Build the actual mobile client: authentication, secure token storage/session lifecycle, wallet, request/split, contacts, merchant flows and QR/deep-link handling. The API creates `euroflow://` links, but there is no corresponding native handler on this branch.
2. Establish approved API origins, native identifiers/store ownership, Expo project, assets and build profiles. Add native bundling, config validation, simulator/debug builds and end-to-end device tests only once real app source exists.
3. Treat the entire product as a demo until a qualified team approves the real-money architecture. The README explicitly says `topup` and `kyc/verify` are stubs and that banking rails, licensing, safeguarding and production KYC/AML/SCA are not implemented. Do not monetize or market these as working financial services based on green CI.
4. Review production authentication/session revocation, persistence/concurrency, auditability, contact-data privacy and regulated-provider integration. This audit changes none of those security or financial settings.
5. Review privacy/legal/store declarations and test on physical devices before any explicitly approved build, submission or real-money launch.

## Verification for this change

- Passed locally: all 47 existing Node API tests; no skips or failures.
- Browser execution is pending a capable runner: local Chromium cannot create its required IPC socket, and downloaded browser archives were incomplete. A requested sandbox escalation failed before execution. No browser journey is being claimed as passed.
- Review the new PR checks before merging. No bank, payment provider, signing service, build service or store was contacted.
