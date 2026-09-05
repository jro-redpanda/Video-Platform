# Mock, Fixture, Stub, and Placeholder Register

This file tracks long-lived non-production implementations and launch-relevant
placeholders. Inline test data and one-off failure injections remain test-local;
they do not imply production readiness or require historical step markers.

| Site | Current behavior | Disposition or exit criteria |
|---|---|---|
| `artifacts/api-server/src/lib/bootstrap.ts` development bootstrap | Creates a development tenant, users, groups, plan, customization, metadata-only videos, and sample audit history. Startup configuration prevents it from running in production. | Retain as a development fixture; it is not onboarding, upload, provider, or audit production evidence. |
| `VID_APP_DOMAIN=app.example.com` | Development-domain placeholder supplied by workspace configuration. | Replace with the approved public application domain before launch and verify redirects/callbacks there. |
| Cold-master storage boundary | Production default is intentionally unconfigured and never manufactures archive success or metadata. | Configure and independently validate an approved byte-storage adapter. |
| Cold-master provider-transfer boundary | Production default is intentionally unconfigured and never manufactures source bytes or target writes. | Configure and independently validate an approved provider transfer adapter. |
| `lib/providers/src/test-only-fake.ts` | Deterministic provider used only by explicit smoke entrypoints or direct test injection; the production registry does not import or fall back to it. | Retain as test-only infrastructure. |
| `lib/providers/src/portable-contract-fixture.ts` | Non-Bunny DASH/multipart fixture used by provider conformance tests. | Retain as test-only contract infrastructure; it is not live-provider portability evidence. |
| `artifacts/api-server/src/lib/test-only-fake-billing-provider.ts` | In-memory billing customer, checkout, and subscription provider imported by the billing smoke only. | Retain as test-only infrastructure; live Stripe lifecycle validation remains separate. |
| `artifacts/api-server/src/custom-domain-smoke.ts` DNS/queue seams | Injected TXT resolver and queue used by the custom-domain smoke. | Retain as test-only infrastructure; it does not prove public DNS, TLS, or edge routing. |
| `artifacts/api-server/src/thumbnail-step15-smoke.ts` storage seam | In-memory thumbnail storage with injected read/delete failures. | Retain as test-only infrastructure; App Storage has a separate explicitly authorized round trip. |
| `artifacts/api-server/src/cold-master-storage-smoke.ts` adapters | In-memory byte storage and provider transfer used to verify local integrity contracts. | Retain as test-only infrastructure; configured storage/provider evidence remains external. |

The separate `artifacts/mockup-sandbox` artifact is development-only design
tooling. Its artifact manifest intentionally has no production service, and it
is not imported by the production application.