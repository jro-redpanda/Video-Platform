# Code Review Groups

This document maps the application into reviewable functional groups. Each
`G-number` is scoped so related runtime code, persistence, frontend behavior,
and local validation can be reviewed together.

Some files appear in multiple groups because they are cross-cutting,
particularly `artifacts/api-server/src/routes/platform.ts` and
`artifacts/api-server/src/lib/jobs.ts`.

## Foundation

### G0 — Runtime bootstrap, configuration, and application composition

**Purpose:** Ensure the API starts safely, validates configuration, mounts
routes correctly, and shuts down cleanly.

**Key files:**

- `artifacts/api-server/src/index.ts`
- `artifacts/api-server/src/app.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/api-server/src/routes/health.ts`
- `artifacts/api-server/src/lib/config.ts`
- `artifacts/api-server/src/lib/logger.ts`
- `artifacts/api-server/src/lib/bootstrap.ts`
- `artifacts/api-server/build.mjs`
- `artifacts/api-server/package.json`

**Review for:**

- Missing or weak environment validation
- Incorrect middleware or route ordering
- Raw-body webhook conflicts
- Startup failures after workers partially start
- Unsafe development bootstrap behavior
- Graceful shutdown and worker cleanup
- Error and secret leakage in logs

**Validation:**

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run g0:smoke
```

### G1 — Authentication, tenant isolation, RBAC, and entitlements

**Purpose:** Protect organization data and enforce permissions and plan
features server-side.

**Key files:**

- `artifacts/api-server/src/lib/auth.ts`
- `artifacts/api-server/src/lib/tenant-context.ts`
- `artifacts/api-server/src/lib/tenant-db.ts`
- `artifacts/api-server/src/lib/permissions.ts`
- `artifacts/api-server/src/lib/entitlements.ts`
- `artifacts/api-server/src/routes/members.ts`
- Relevant sections of `artifacts/api-server/src/routes/platform.ts`
- `lib/db/src/schema/identity.ts`
- `lib/db/src/schema/organizations.ts`
- `lib/db/src/schema/operations.ts`

**Frontend:**

- `artifacts/vid/src/pages/login.tsx`
- `artifacts/vid/src/pages/members.tsx`
- `artifacts/vid/src/pages/settings.tsx`
- `artifacts/vid/src/App.tsx`

**Review for:**

- Cross-tenant reads or writes
- User-controlled organization IDs
- Missing permission checks
- Role-escalation paths
- Invitation replay or enumeration
- Entitlements enforced only in the frontend
- Session fixation, redirect, or logout problems
- RLS context not set consistently

**Depends on:** G0 and G3.

### G2 — Workspace onboarding and provider provisioning

**Purpose:** Create the first organization, owner membership, default
configuration, and durable provider-provisioning intent.

**Key files:**

- `artifacts/api-server/src/routes/onboarding.ts`
- `artifacts/api-server/src/lib/workspace-onboarding.ts`
- `artifacts/api-server/src/lib/tenant-provisioning.ts`
- `artifacts/api-server/src/lib/provider-registry.ts`
- `artifacts/api-server/src/lib/credential-encryption.ts`
- Onboarding portions of `artifacts/api-server/src/lib/jobs.ts`
- `artifacts/vid/src/pages/onboarding.tsx`
- `lib/db/src/schema/onboarding.ts`
- `lib/db/migrations/0029_workspace_onboarding.sql`
- `ONBOARDING_OPERATIONS.md`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run onboarding:smoke
```

**Review for:**

- Duplicate workspace creation
- Partial organization setup
- Incorrect retry behavior
- Provider side effects occurring before durable claims
- Stuck pending/dispatching states
- Reconciliation handling
- False “ready” UI
- Production use of test-provider seams

**External gate:** Live Bunny provisioning must remain deferred until valid
credentials exist.

### G3 — Database schema, migrations, RLS, and grants

**Purpose:** Verify persistence integrity, tenant isolation, migration safety,
and worker access.

**Key files:**

- `lib/db/src/schema/identity.ts`
- `lib/db/src/schema/organizations.ts`
- `lib/db/src/schema/videos.ts`
- `lib/db/src/schema/operations.ts`
- `lib/db/src/schema/billing.ts`
- `lib/db/src/schema/thumbnails.ts`
- `lib/db/src/schema/onboarding.ts`
- `lib/db/src/schema/custom-domain.ts`
- `lib/db/src/schema/index.ts`
- `lib/db/scripts/catalog.ts`
- `lib/db/scripts/accept-migrations.ts`
- `lib/db/scripts/migrate.ts`
- `lib/db/scripts/verify-schema.ts`
- `lib/db/migrations/*.sql`

**Important recent migrations:**

- `0021`–`0024`: billing
- `0025`–`0026`: analytics
- `0027`–`0028`: audit
- `0029`: onboarding
- `0030`: custom domains
- `0031`–`0032`: cold-master operations and integrity

**Validation:**

```bash
pnpm --filter @workspace/db run accept-migrations
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/db run verify-schema
```

**Review for:**

- Missing foreign keys or uniqueness constraints
- Inconsistent Drizzle and SQL schemas
- Incorrect RLS or grants
- Worker roles with excessive access
- Mutable audit records
- Unsafe migration adoption or checksum handling
- Migration behavior with legacy production data

**Important:** Never use `prototype:push` against production.

### G4 — Provider abstraction and Bunny adapter

**Purpose:** Keep the core app provider-neutral and ensure unavailable
providers fail closed.

**Key files:**

- `lib/providers/src/contracts.ts`
- `lib/providers/src/registry.ts`
- `lib/providers/src/index.ts`
- `lib/providers/src/unconfigured.ts`
- `lib/providers/src/bunny/index.ts`
- `lib/providers/src/test-only-fake.ts`
- `lib/providers/src/provider-conformance-smoke.ts`
- `artifacts/api-server/src/lib/provider-registry.ts`
- `artifacts/api-server/src/lib/bunny-roundtrip.ts`
- `PROVIDER_UNAVAILABLE_OPERATIONS.md`

**Validation:**

```bash
pnpm --filter @workspace/providers run typecheck
pnpm --filter @workspace/providers run conformance:smoke
```

**Review for:**

- Bunny-specific concepts escaping the adapter
- Incorrect capability reporting
- Network calls during configuration inspection
- Untrusted playback URLs
- Unsafe credential handling
- Inconsistent transient/definitive errors
- Test adapters accidentally usable in production

**External gate:**

```bash
pnpm --filter @workspace/api-server run provider:smoke
```

This performs a real Bunny-dependent round trip and should remain deferred.

## Core video lifecycle

### G5 — Video creation, direct upload, finalization, webhooks, and deletion

**Purpose:** Manage the provider-neutral lifecycle from owned video creation
through ready/error/deleted states.

**Key files:**

- Upload and lifecycle sections of `artifacts/api-server/src/routes/platform.ts`
- `artifacts/api-server/src/routes/provider-webhooks.ts`
- `artifacts/api-server/src/lib/upload-expiry-cleanup.ts`
- `artifacts/api-server/src/lib/tenant-provisioning.ts`
- Video lifecycle portions of `artifacts/api-server/src/lib/jobs.ts`
- `lib/db/src/schema/videos.ts`
- `artifacts/api-server/src/upload-step9-smoke.ts`
- `artifacts/api-server/src/webhook-step10-smoke.ts`

**Smokes:**

```bash
pnpm --filter @workspace/api-server run upload:smoke
pnpm --filter @workspace/api-server run webhook:smoke
```

**Review for:**

- Invalid state transitions
- Upload session replay
- Expired upload cleanup
- Webhook signature and deduplication
- Events attached to the wrong tenant/video
- Delete retries and provider ambiguity
- Provider IDs leaking into public responses
- Race conditions between upload, webhook, and deletion

**External gate:** Real upload/webhook/delete behavior needs valid provider
credentials.

### G6 — Video library, folders, search, pagination, and bulk actions

**Purpose:** Provide tenant-scoped video organization and high-volume
mutations.

**Key files:**

- Library sections of `artifacts/api-server/src/routes/platform.ts`
- `artifacts/api-server/src/routes/folders.ts`
- `artifacts/vid/src/pages/videos.tsx`
- `artifacts/vid/src/pages/video-detail.tsx`
- `lib/db/src/schema/videos.ts`
- `artifacts/api-server/src/video-library-step12-smoke.ts`
- `artifacts/api-server/src/folders-step13-smoke.ts`
- `artifacts/api-server/src/bulk-video-step14-smoke.ts`

**Smokes:**

```bash
pnpm --filter @workspace/api-server run library:smoke
pnpm --filter @workspace/api-server run folders:smoke
pnpm --filter @workspace/api-server run bulk-video:smoke
```

**Review for:**

- Unsigned or cross-tenant cursors
- Pagination duplication or omission after mutations
- Folder cycles and concurrent moves
- Deleting non-empty folders
- Bulk partial failures
- Selection state becoming stale
- Search/filter inconsistencies

### G7 — Embeds, playback resolution, and player security

**Purpose:** Serve stable owned embeds while resolving short-lived provider
playback safely.

**Key files:**

- `artifacts/api-server/src/routes/public.ts`
- Playback sections of `artifacts/api-server/src/routes/platform.ts`
- `artifacts/api-server/src/lib/video-embeds.ts`
- `artifacts/api-server/src/lib/playback-analytics.ts`
- `artifacts/vid/src/pages/embed-player.tsx`
- `artifacts/vid/src/components/player.tsx`
- `artifacts/api-server/src/embed-step11-smoke.ts`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run embed:smoke
```

**Review for:**

- Provider URLs leaking into embed markup
- Playback redirects to untrusted origins
- Expired playback manifests
- Missing cache-control headers
- Embed policy/origin mistakes
- Public access to private videos
- XSS through video metadata or embed configuration
- Player states when provider playback is unavailable

### G8 — Thumbnails and object-storage lifecycle

**Purpose:** Upload, validate, promote, serve, replace, and clean up
thumbnails.

**Key files:**

- `artifacts/api-server/src/routes/thumbnails.ts`
- `artifacts/api-server/src/lib/thumbnail-storage.ts`
- `artifacts/api-server/src/lib/thumbnail-cleanup.ts`
- `artifacts/vid/src/components/thumbnail-manager.tsx`
- `lib/db/src/schema/thumbnails.ts`
- `lib/db/migrations/0015_thumbnails.sql`
- `lib/db/migrations/0016_thumbnail_integrity.sql`
- `artifacts/api-server/src/thumbnail-step15-smoke.ts`
- `artifacts/api-server/src/thumbnail-storage-roundtrip-smoke.ts`
- `artifacts/api-server/src/thumbnail-cleanup-once.ts`

**Local smoke:**

```bash
pnpm --filter @workspace/api-server run thumbnail:smoke
```

**Potentially storage-side-effecting:**

```bash
pnpm --filter @workspace/api-server run thumbnail:storage-smoke
```

**Operational/destructive cleanup:**

```bash
pnpm --filter @workspace/api-server run thumbnail:cleanup-once
```

**Review for:**

- Object ownership and tenant scoping
- Content type and size validation
- Promotion metadata loss
- Generation/version races
- Orphaned objects
- Cleanup deleting current thumbnails
- Signed upload misuse

## Business and administrative capabilities

### G9 — Analytics collection, abuse prevention, and rollups

**Purpose:** Collect playback events, prevent forged/unbounded telemetry, and
calculate tenant analytics.

**Key files:**

- `artifacts/api-server/src/lib/playback-analytics.ts`
- `artifacts/api-server/src/lib/analytics-rollup.ts`
- Analytics sections of `artifacts/api-server/src/routes/platform.ts`
- Public events route in `artifacts/api-server/src/routes/public.ts`
- Analytics portions of `artifacts/api-server/src/lib/jobs.ts`
- `artifacts/vid/src/pages/analytics.tsx`
- `lib/db/migrations/0025_production_analytics.sql`
- `lib/db/migrations/0026_analytics_session_attestations.sql`
- `artifacts/api-server/src/analytics-smoke.ts`
- `ANALYTICS_OPERATIONS.md`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run analytics:smoke
```

**Review for:**

- Client-forged sessions
- Unbounded watch time
- Event replay
- Cross-tenant aggregates
- Retry queues overwriting events
- Time-window and timezone errors
- Rate limits that fail open

### G10 — Audit logs, cursor pagination, export, and redaction

**Purpose:** Maintain an append-only tenant audit trail without exposing
sensitive values.

**Key files:**

- `artifacts/api-server/src/lib/audit.ts`
- Audit routes in `artifacts/api-server/src/routes/platform.ts`
- Audit writes throughout feature routes
- `artifacts/vid/src/pages/audit.tsx`
- `lib/db/migrations/0027_audit_log_foundation.sql`
- `lib/db/migrations/0028_audit_export_rate_window.sql`
- `artifacts/api-server/src/audit-smoke.ts`
- `AUDIT_OPERATIONS.md`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run audit:smoke
```

**Review for:**

- Missing security-sensitive events
- Mutable or deletable audit records
- Secret leakage inside nested metadata
- Oversized event payloads
- CSV injection
- Cross-tenant cursors
- Export rate-limit bypasses

### G11 — Billing, plans, Stripe sync, checkout, and reconciliation

**Purpose:** Synchronize plans, create checkout sessions, process Stripe
events, and resolve billing access.

**Key files:**

- `artifacts/api-server/src/routes/billing.ts`
- `artifacts/api-server/src/lib/billing-provider.ts`
- `artifacts/api-server/src/lib/billing-lifecycle-lock.ts`
- `artifacts/api-server/src/lib/billing-reconciliation.ts`
- `artifacts/api-server/src/lib/stripe-client.ts`
- `artifacts/api-server/src/lib/stripe-startup.ts`
- `artifacts/api-server/src/lib/stripe-webhook.ts`
- `artifacts/api-server/src/lib/test-only-fake-billing-provider.ts`
- Billing portions of `artifacts/api-server/src/lib/jobs.ts`
- `lib/db/src/schema/billing.ts`
- `artifacts/api-server/src/billing-step18-smoke.ts`
- `scripts/src/seed-stripe-catalog.ts`
- `STRIPE_OPERATIONS.md`

**Local smoke:**

```bash
pnpm --filter @workspace/api-server run billing:smoke
```

**External and side-effecting:**

```bash
pnpm --filter @workspace/scripts run stripe:seed
```

**Review for:**

- Duplicate customers/checkouts
- Webhook ordering and replay
- Deleted Stripe customer reuse
- Downgrade/cancellation timing
- Entitlement drift
- Past-due grace behavior
- Reconciliation and dead-letter handling
- Test billing adapter escaping into production

### G12 — Branding, customization, and custom domains

**Purpose:** Control plan-gated branding and local DNS-verification lifecycle.

**Key files:**

- `artifacts/vid/src/pages/customization.tsx`
- `artifacts/vid/src/components/custom-domain-manager.tsx`
- `artifacts/api-server/src/routes/custom-domain.ts`
- `artifacts/api-server/src/lib/custom-domain.ts`
- `artifacts/api-server/src/lib/domain-dns-resolver.ts`
- `lib/db/src/schema/custom-domain.ts`
- `lib/db/migrations/0030_custom_domains.sql`
- `artifacts/api-server/src/custom-domain-smoke.ts`
- `CUSTOM_DOMAIN_OPERATIONS.md`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run custom-domain:smoke
```

**Review for:**

- Domain takeover or cross-tenant claims
- Unsafe hostname parsing
- Private/internal hostname acceptance
- Verification-token leakage
- DNS rebinding assumptions
- Verification retry abuse
- Incorrect activation claims
- Branding entitlements enforced only in UI
- Removal/reconciliation behavior

**External gate:** TLS issuance, edge routing, and live custom-domain traffic
are not currently implemented/configured.

### G13 — Cold-master archive and restore

**Purpose:** Archive master video bytes independently of the delivery provider
and restore them through durable operations.

**Key files:**

- `artifacts/api-server/src/routes/master-storage.ts`
- `artifacts/api-server/src/lib/master-storage-operations.ts`
- `artifacts/api-server/src/lib/cold-master-storage.ts`
- `artifacts/api-server/src/lib/cold-master-transfer.ts`
- Master-storage portions of `artifacts/api-server/src/lib/jobs.ts`
- `lib/db/src/schema/videos.ts`
- `lib/db/migrations/0031_master_storage_operations.sql`
- `lib/db/migrations/0032_master_archive_integrity.sql`
- `artifacts/api-server/src/cold-master-storage-smoke.ts`
- `artifacts/api-server/src/master-storage-lifecycle-smoke.ts`
- `docs/master-storage-operations.md`

**Smokes:**

```bash
pnpm --filter @workspace/api-server run cold-master:smoke
pnpm --filter @workspace/api-server run master-storage:lifecycle-smoke
```

**Review for:**

- Partial stream consumption
- Hash, size, or content-type mismatches
- Incorrect restore target
- Duplicate provider-side writes
- Queue delivery suppressed by old job IDs
- Incorrect terminal vs reconciliation states
- Storage/provider calls inside DB transactions
- Restoration of legacy unverified archives
- Object keys or provider IDs leaking publicly

**External gate:** Real cold storage and provider-transfer adapters are still
unconfigured.

### G14 — Durable jobs, workers, retries, and maintenance

**Purpose:** Operate every background workflow safely and recover stale work.

**Primary file:**

- `artifacts/api-server/src/lib/jobs.ts`

**Supporting files:**

- `artifacts/api-server/src/lib/tenant-provisioning.ts`
- `artifacts/api-server/src/lib/billing-reconciliation.ts`
- `artifacts/api-server/src/lib/analytics-rollup.ts`
- `artifacts/api-server/src/lib/thumbnail-cleanup.ts`
- `artifacts/api-server/src/lib/upload-expiry-cleanup.ts`
- `artifacts/api-server/src/lib/master-storage-operations.ts`
- `artifacts/api-server/src/queue-smoke.ts`
- `lib/db/migrations/0020_pgboss_12_29_0.sql`

**Smoke:**

```bash
pnpm --filter @workspace/api-server run queue:smoke
```

**Review for:**

- Missing durable claims
- Duplicate side effects
- Attempts consumed by enqueue failures
- Stale dispatching/queued/processing states
- Job-ID reuse
- Retry storms
- Dead-letter records without recovery
- Worker shutdown during an active claim
- One failing queue preventing unrelated workers from starting

This group is especially suitable for one consolidated review because queue
behavior crosses onboarding, billing, analytics, deletion, and cold-master
operations.

## Contracts and frontend

### G15 — OpenAPI contract, validation, and generated clients

**Purpose:** Keep the backend API, request validation, frontend hooks, and
generated types synchronized.

**Source of truth:**

- `lib/api-spec/openapi.yaml`
- `lib/api-spec/orval.config.ts`

**Generated outputs—do not hand-edit:**

- `lib/api-zod/src/generated/**`
- `lib/api-client-react/src/generated/**`

**Generation command:**

```bash
pnpm --filter @workspace/api-spec run codegen
```

**Review for:**

- Routes missing from OpenAPI
- Runtime responses that differ from schemas
- Weak union validation
- Generated client mutation signatures
- Nullability and enum drift
- Sensitive fields accidentally exposed
- Codegen producing unexplained diffs

The codegen command writes files, so it should be run only when regeneration
is intended.

### G16 — Frontend shell, routing, query state, and shared UI

**Purpose:** Review the frontend as a complete application rather than
duplicating every backend feature review.

**Key files:**

- `artifacts/vid/src/App.tsx`
- `artifacts/vid/src/main.tsx`
- `artifacts/vid/src/pages/dashboard.tsx`
- `artifacts/vid/src/pages/not-found.tsx`
- `artifacts/vid/src/components/error-boundary.tsx`
- Shared API/query/auth utilities under `artifacts/vid/src/lib/**`
- Shared primitives under `artifacts/vid/src/components/ui/**`
- `artifacts/vid/vite.config.ts`
- `artifacts/vid/package.json`

**Feature pages covered with their backend groups:**

- `login.tsx`, `members.tsx`, `settings.tsx` → G1
- `onboarding.tsx` → G2
- `videos.tsx`, `video-detail.tsx` → G5/G6/G8
- `embed-player.tsx`, `player.tsx` → G7
- `analytics.tsx` → G9
- `audit.tsx` → G10
- `customization.tsx`, `custom-domain-manager.tsx` → G12

**Validation:**

```bash
pnpm --filter @workspace/vid run typecheck
pnpm --filter @workspace/vid run build
```

**Review for:**

- Incorrect auth/tenant routing
- Direct-navigation failures
- Stale React Query state after mutations
- Silent API errors
- Missing loading/empty/error states
- Accessibility and keyboard behavior
- Unsafe HTML or URL handling
- Internal `vid` or removed product names becoming visible
- Mobile/responsive failures

### G17 — Operational readiness, documentation, mocks, and security

**Purpose:** Ensure the code’s operational behavior matches documented
procedures and launch claims.

**Key files:**

- `LAUNCH_CHECKLIST.md`
- `INCIDENT_RESPONSE.md`
- `RECOVERY_OPERATIONS.md`
- `PROVIDER_UNAVAILABLE_OPERATIONS.md`
- `ONBOARDING_OPERATIONS.md`
- `CUSTOM_DOMAIN_OPERATIONS.md`
- `STRIPE_OPERATIONS.md`
- `ANALYTICS_OPERATIONS.md`
- `AUDIT_OPERATIONS.md`
- `docs/master-storage-operations.md`
- `MOCKS.md`
- `replit.md`
- `.npmrc`
- `pnpm-workspace.yaml`
- `package.json`
- Artifact manifests under `artifacts/*/.replit-artifact/`

**Review for:**

- Docs claiming unavailable systems are configured
- Stale mock/replacement markers
- Missing incident or rollback procedures
- Tests relying on production services
- Vulnerable dependency overrides becoming stale
- Secrets or credentials in source/logs
- Workflow commands diverging from deployment behavior

## Global scripts worth reviewing

### Standard non-external checks

```bash
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/providers run conformance:smoke
git diff --check
```

### Database checks

```bash
pnpm --filter @workspace/db run accept-migrations
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/db run verify-schema
```

These mutate the selected development/test database. They must not be casually
pointed at production.

### Local feature-smoke suite

```bash
pnpm --filter @workspace/api-server run queue:smoke
pnpm --filter @workspace/api-server run upload:smoke
pnpm --filter @workspace/api-server run webhook:smoke
pnpm --filter @workspace/api-server run embed:smoke
pnpm --filter @workspace/api-server run library:smoke
pnpm --filter @workspace/api-server run folders:smoke
pnpm --filter @workspace/api-server run bulk-video:smoke
pnpm --filter @workspace/api-server run thumbnail:smoke
pnpm --filter @workspace/api-server run billing:smoke
pnpm --filter @workspace/api-server run analytics:smoke
pnpm --filter @workspace/api-server run audit:smoke
pnpm --filter @workspace/api-server run onboarding:smoke
pnpm --filter @workspace/api-server run custom-domain:smoke
pnpm --filter @workspace/api-server run cold-master:smoke
pnpm --filter @workspace/api-server run master-storage:lifecycle-smoke
```

These use the development database and create temporary records, so they
should not run against production.

### External or operational actions

Do not include these in a routine bug review without explicit approval:

```bash
# Real Bunny-dependent operation
pnpm --filter @workspace/api-server run provider:smoke

# Writes Stripe catalog/test-account data
pnpm --filter @workspace/scripts run stripe:seed

# May use configured object storage
pnpm --filter @workspace/api-server run thumbnail:storage-smoke

# Operational cleanup—not a harmless test
pnpm --filter @workspace/api-server run thumbnail:cleanup-once
```

## Recommended order

1. **G0** — Runtime/configuration
2. **G3** — Database/RLS/migrations
3. **G1** — Auth/tenant/RBAC
4. **G4** — Provider abstraction
5. **G14** — Queues/workers
6. **G2** — Onboarding/provisioning
7. **G5** — Upload/video lifecycle
8. **G6** — Library/folders/bulk
9. **G7** — Embed/player/playback
10. **G8** — Thumbnails/storage
11. **G9** — Analytics
12. **G10** — Audit
13. **G11** — Billing
14. **G12** — Branding/custom domains
15. **G13** — Cold-master archive/restore
16. **G15** — API/codegen consistency
17. **G16** — Frontend integration and UX
18. **G17** — Launch/security/operations

## Larger review bundles

- **Foundation bundle:** G0 + G1 + G3
- **Provider/control-plane bundle:** G2 + G4 + G14
- **Core video bundle:** G5 + G6 + G7 + G8
- **Telemetry/compliance bundle:** G9 + G10
- **Commercial/white-label bundle:** G11 + G12
- **Portability bundle:** G13 + provider portions of G4
- **Contract/frontend bundle:** G15 + G16
- **Launch bundle:** G17 plus final checks from every preceding group