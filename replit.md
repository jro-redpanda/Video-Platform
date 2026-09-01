# Multi-Tenant Video Platform

A provider-portable control plane for customer video libraries, embeds, workspace permissions, customization, and first-party analytics.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/video-platform` — tenant-facing React application
- `artifacts/api-server/src/routes/platform.ts` — current API implementation and demo records
- `lib/api-spec/openapi.yaml` — source of truth for the application API
- `lib/db/src/schema` — durable Postgres schema as persistence is added

## Architecture decisions

- The displayed product name remains runtime configuration; internal identifiers use neutral video-domain names.
- Public video IDs and embed URLs must never contain a provider asset ID or hostname.
- Provider-specific code belongs behind adapters; tenant-facing code consumes normalized types.
- Tenant scope, permissions, and entitlements must be resolved server-side rather than trusted from client input.

## Product

The first slice includes a workspace dashboard, video library and upload records, video detail and embed workflow, analytics, member/group surfaces, live player customization, and workspace plan/settings.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
