# Mock, Fixture, Stub, and Placeholder Register

This file tracks every non-production implementation currently present. Each code site carries a greppable `// MOCK: replaced at step N` marker.

| Site | Current behavior | Replacement |
|---|---|---|
| `artifacts/api-server/src/lib/bootstrap.ts` development bootstrap | Creates the development tenant, user, groups, plan, customization, and sample records. It never runs in production. | Step 18 production onboarding and hardening |
| `artifacts/api-server/src/lib/bootstrap.ts` demo videos | Seeds four metadata-only videos without provider assets. Development-only fixtures do not exercise direct upload. | Step 18 production onboarding and hardening |
| `artifacts/api-server/src/lib/bootstrap.ts` analytics rollups | Seeds sample play/watch/completion totals. | Step 16 beacon rollup worker |
| `artifacts/api-server/src/lib/bootstrap.ts` audit activity | Seeds sample audit history. | Step 17 platform audit operations |
| `artifacts/api-server/src/routes/platform.ts` dashboard trend | Returns fixed daily trend points around persisted totals. | Step 16 analytics rollups |
| `artifacts/api-server/src/routes/public.ts` beacon ingestion | Preliminary direct event insert without rate limits or rollup processing. Do not extend this implementation. | Step 16 beacon and rollup pipeline |
| `artifacts/vid/src/pages/settings.tsx` upgrade/billing controls | Buttons are visual placeholders with no commerce action. | Step 8 plan and entitlement flow |
| `lib/providers/src/unconfigured.ts` second provider | Explicit fail-closed second adapter with no external implementation. | Step 18 provider hardening |
| `VID_APP_DOMAIN=app.example.com` | Runtime-configured development domain placeholder. | Step 18 production hardening |
| Cold-master storage | Intentionally unconfigured behind the provider-neutral cold-master boundary; no archival success is manufactured. | External R2/cold storage configuration |
| `lib/providers/src/test-only-fake.ts` Step 7 smoke provider | Deterministic in-process provider used only by `queue:smoke`; it is never a production fallback. | Test-only smoke infrastructure |

The separate `artifacts/mockup-sandbox` artifact is design tooling and is not imported by the production application.