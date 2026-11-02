# Mobile readiness — 2026-11-02

Status: development preview, **not ready for App Store or Google Play submission**.

Only `mobile/` was recovered from `mobile/euroflow-foundation`. Its older business
and contacts changes were deliberately not included. Missing router screens,
TypeScript configuration, lockfile and build profiles are now supplied.

This is an offline informational prototype. It does not connect to the backend or
collect identity, bank, or card information. The existing backend's local wallet
credits, transfers, and KYC status changes remain simulations, not provider-backed
money movement or verification. Passing backend tests does not establish financial
or regulatory readiness.

Required before a live service: select and contract regulated payment/banking and
identity providers; implement server-side provider integration and verified webhooks;
transaction idempotency, ledger consistency, reconciliation, refunds and disputes;
real AML/sanctions monitoring and operational escalation; custody/safeguarding model;
authentication, fraud prevention and access-control review; approved privacy, terms,
retention/deletion and jurisdiction-specific compliance review. These are not satisfied
by this PR. No real-money controls are exposed in mobile.

## Reproducible local validation

Use Node 22 or newer:

```sh
cd mobile
npm ci
npm run typecheck
EXPO_OFFLINE=1 npx expo export --platform ios --platform android --output-dir dist
```

The PR workflow runs typechecking and both JavaScript bundle exports. Bundle export
is not a native Xcode/Gradle build, device test, signed release, or store approval.
The lockfile records the prototype's Expo SDK 54 dependencies. Review SDK currency,
security updates, platform target requirements and compatibility before release.

## Workspace evidence

Mobile typecheck and iOS/Android Hermes exports passed. Existing backend suite:
34 passed. These tests validate simulation behavior, not financial-provider integration.

Exports used `EXPO_OFFLINE=1` because the Expo metadata fetch failed in this
environment. Native compilation, signed builds and device QA were not performed.

## Signing and release gate

`eas.json` defines internal preview and production build profiles with remote version
management. Submission profiles were intentionally omitted. No cloud builds were
started, credentials created, stores configured, or releases submitted.

Before an owner-authorized build: verify ownership of the bundle identifiers in
`app.json`, link the correct EAS project, supply existing iOS provisioning and Android
upload-key credentials through the approved signing service, and verify version/build
numbers. Then perform signed device builds and review their permissions and manifests.
Do not store credentials in git. Signing and store validation remain unverified.

Before public release also complete branded icons/splash/screenshots, accessible UI
and device QA, review notes/demo access, support and privacy URLs, privacy disclosures,
data-safety declarations, account deletion where accounts exist, and functional
acceptance tests. This small preview alone is not sufficient product functionality
for submission.
