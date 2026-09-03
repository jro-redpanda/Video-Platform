# Mock, Fixture, Stub, and Placeholder Register

This file tracks every non-production implementation currently present. Each code site carries a greppable `// MOCK: replaced at step N` marker.

| Site | Current behavior | Replacement |
|---|---|---|
| `artifacts/api-server/src/lib/bootstrap.ts` development bootstrap | Creates the development tenant, user, groups, plan, customization, and sample records. It never runs in production; production workspace onboarding is implemented separately. | Development fixture only |
| `artifacts/api-server/src/lib/bootstrap.ts` demo videos | Seeds four metadata-only videos without provider assets. Development-only fixtures do not exercise direct upload. | Step 18 production onboarding and hardening |
| `artifacts/api-server/src/lib/bootstrap.ts` audit activity | Seeds sample audit history. | Step 17 platform audit operations |
| `VID_APP_DOMAIN=app.example.com` | Runtime-configured development domain placeholder. | Step 18 production hardening |
| Cold-master storage | Intentionally unconfigured behind a provider-neutral byte-storage boundary; no archival success or metadata is manufactured. | External cold storage configuration |
| Cold-master provider transfer | Intentionally unconfigured byte-stream source/restore boundary. It makes no provider-health claim and never manufactures source bytes or target writes. | Explicit production transfer adapter configuration |
| `lib/providers/src/test-only-fake.ts` Step 7 smoke provider | Deterministic in-process provider used only by `queue:smoke`; it is never a production fallback. | Test-only smoke infrastructure |
| `lib/providers/src/test-only-fake.ts` onboarding smoke provider | Verifies workspace activation without network access in `onboarding:smoke`; production resolution remains fail-closed. | Test-only smoke infrastructure |
| Custom-domain smoke DNS resolver | Injected deterministic TXT resolver used only by `custom-domain:smoke`; production worker uses Node TXT resolution and never trusts CNAME/A/AAAA records. | Test-only smoke infrastructure |

The separate `artifacts/mockup-sandbox` artifact is design tooling and is not imported by the production application.