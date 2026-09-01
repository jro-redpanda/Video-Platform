# Mock, Fixture, Stub, and Placeholder Register

This file tracks every non-production implementation currently present. Each code site carries a greppable `// MOCK: replaced at step N` marker.

| Site | Current behavior | Replacement |
|---|---|---|
| `artifacts/api-server/src/lib/bootstrap.ts` development bootstrap | Creates the development tenant, user, groups, plan, customization, and sample records. It never runs in production. | Step 18 production onboarding and hardening |
| `artifacts/api-server/src/lib/bootstrap.ts` demo videos | Seeds four metadata-only videos without provider assets. | Step 9 upload flow |
| `artifacts/api-server/src/lib/bootstrap.ts` analytics rollups | Seeds sample play/watch/completion totals. | Step 16 beacon rollup worker |
| `artifacts/api-server/src/lib/bootstrap.ts` audit activity | Seeds sample audit history. | Step 17 platform audit operations |
| `artifacts/api-server/src/routes/platform.ts` dashboard trend | Returns fixed daily trend points around persisted totals. | Step 16 analytics rollups |
| `artifacts/api-server/src/routes/platform.ts` create-video route | Creates a metadata row without transferring media. | Step 9 upload credentials and resumable client |
| `artifacts/vid/src/pages/videos.tsx` upload dialog | Creates metadata only; it has no file picker, progress, or resume. | Step 9 upload flow |
| `artifacts/api-server/src/routes/public.ts` public playback metadata | Preliminary owned-ID response without resolved signed playback sources. Do not extend this implementation. | Step 11 player and embed generator |
| `artifacts/vid/src/pages/embed-player.tsx` embed facade | Preliminary disabled player with an explicit unconnected-source message. Replace the file rather than patching it forward. | Step 11 player and embed generator |
| `artifacts/vid/src/pages/video-detail.tsx` iframe markup | Builds preliminary iframe markup directly in the page. | Step 11 embed generator |
| `artifacts/vid/src/pages/customization.tsx` player preview | Draws decorative fake video content rather than using the shared player wrapper. | Step 11 player wrapper |
| `artifacts/api-server/src/routes/public.ts` beacon ingestion | Preliminary direct event insert without rate limits or rollup processing. Do not extend this implementation. | Step 16 beacon and rollup pipeline |
| `artifacts/vid/src/pages/settings.tsx` upgrade/billing controls | Buttons are visual placeholders with no commerce action. | Step 8 plan and entitlement flow |
| `lib/providers/src/unconfigured.ts` second provider | Explicit fail-closed second adapter with no external implementation. | Step 18 provider hardening |
| `VID_APP_DOMAIN=app.example.com` | Runtime-configured development domain placeholder. | Step 18 production hardening |
| Cold-master storage | Intentionally unconfigured behind the provider boundary. | Step 9 master archival |

The separate `artifacts/mockup-sandbox` artifact is design tooling and is not imported by the production application.