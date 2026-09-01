# Multi-Tenant Video Platform

A provider-portable control plane for customer video libraries, embeds, workspace permissions, customization, and first-party analytics.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/vid run dev` — run the tenant-facing web application
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required runtime config: `PRODUCT_NAME`, `VID_APP_DOMAIN`
- Required secret for the Step 6 provider adapter: `BUNNY_API_KEY`
- Required secret for Step 7 credential encryption: `SESSION_SECRET`

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
- Provider-space provisioning belongs to the Step 7 background worker and must never run inside an HTTP request.
- Provider account credentials are AES-256-GCM encrypted at rest with a `SESSION_SECRET`-derived key; no API exposes them.
- `artifacts/api-server/src/routes/public.ts` and `artifacts/vid/src/pages/embed-player.tsx` are preliminary scaffolding to replace at Step 11, not foundations to extend.

## Product

The first slice includes a workspace dashboard, video library and upload records, video detail and embed workflow, analytics, member/group surfaces, live player customization, and workspace plan/settings.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Keep `vid` for internal identifiers only. User-visible product naming comes from `PRODUCT_NAME`.
- Keep `MOCKS.md` and every `// MOCK: replaced at step N` marker current.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
