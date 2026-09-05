# Multi-Tenant Video Platform

A provider-portable control plane for customer video libraries, embeds, workspace permissions, customization, and first-party analytics.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/vid run dev` — run the tenant-facing web application
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run prototype:push` — local prototypes only; never a production migration procedure
- Production prerequisites, migrations, guarded smokes, provider checks, and rollback gates are defined in `LAUNCH_CHECKLIST.md`; never infer health from configured environment variables
- API and web development/production commands are owned by their artifact manifests; `artifacts/mockup-sandbox` is development-only design tooling

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/vid` — tenant-facing React application
- `artifacts/api-server/src/routes/platform.ts` — current tenant API implementation
- `lib/api-spec/openapi.yaml` — source of truth for the application API
- `lib/db/src/schema` — durable Postgres schema as persistence is added

## Architecture decisions

- The displayed product name remains runtime configuration; internal identifiers use neutral video-domain names.
- Public video IDs and embed URLs must never contain a provider asset ID or hostname.
- Provider-specific code belongs behind adapters; tenant-facing code consumes normalized types.
- Tenant scope, permissions, and entitlements must be resolved server-side rather than trusted from client input.
- Provider-space provisioning belongs to the durable background worker and must never run inside an HTTP request.
- Provider account credentials are AES-256-GCM encrypted at rest with a `SESSION_SECRET`-derived key; no API exposes them.
- Public playback routes and the embed player are production code; preserve provider-asset secrecy, source attestation, and public-route isolation when extending them.

## Product

The first slice includes a workspace dashboard, video library and upload records, video detail and embed workflow, analytics, member/group surfaces, live player customization, and workspace plan/settings.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Keep `vid` for internal identifiers only. User-visible product naming comes from `PRODUCT_NAME`.
- Keep `MOCKS.md` synchronized with long-lived non-production implementations and externally gated placeholders.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
