# Production launch checklist

This checklist distinguishes code/configuration readiness from the health of a
remote dependency. A configured adapter is not proof that its remote service is
reachable or usable.

## Preflight

- [ ] Record the release revision, migration ledger state, change approver, and
  rollback decision owner.
- [ ] Confirm the schema-owner connection has `DATABASE_URL`; confirm runtime
  connections use the least-privileged application role. Do not use schema
  creation or ad-hoc schema changes at runtime.
- [ ] Provide required runtime configuration without placing values in tickets
  or logs: `DATABASE_URL`, `SESSION_SECRET`, `PRODUCT_NAME`, and
  `VID_APP_DOMAIN`. Provide credential-encryption configuration for persisted
  provider credentials. Billing also requires its connector/workload/domain
  configuration as described in [STRIPE_OPERATIONS.md](STRIPE_OPERATIONS.md).
- [ ] Confirm production does not run development bootstrap data or test-only
  provider/DNS seams. Review [MOCKS.md](MOCKS.md).
- [ ] Confirm secret handling, runtime-role grants, RLS, audit append-only
  access, and log redaction. See [AUDIT_OPERATIONS.md](AUDIT_OPERATIONS.md).
- [ ] Check dependency *health* using approved non-secret operational signals;
  do not treat a configured flag or present environment variable as a health
  result.

## Database acceptance, migration, and verification

1. Take the organization-approved recovery precaution and record the current
   migration ledger/catalog.
2. Run migration acceptance against the target database/catalog. For a reviewed
   existing pre-ledger database, use only the explicit adoption procedure in
   [lib/db/MIGRATIONS.md](lib/db/MIGRATIONS.md); otherwise investigate
   discrepancies.
3. Run `pnpm --filter @workspace/db migrate` with the schema-owner connection.
4. Run `pnpm --filter @workspace/db verify-schema`.
5. Only after verification succeeds, start API replicas and then workers.
   PgBoss instances use `migrate:false`; queue schema changes belong to the
   migration phase.

Never alter recorded migration checksums, rewrite applied migrations, or repair
production by dropping data.

## Worker and queue readiness

- [ ] Confirm the worker can connect to the database and the managed `vid_jobs`
  objects, and that the dead-letter queue is observable.
- [ ] Confirm scheduled work is registered: upload expiry, embed dispatch,
  thumbnail cleanup, billing reconciliation, analytics rollup/retention,
  onboarding dispatch, custom-domain repair, and master-storage dispatch.
- [ ] Check for a growing dead-letter queue, stale claims, retry exhaustion, or
  `reconciliation_required` records before enabling corresponding writes.
- [ ] Confirm durable outboxes/intents, rather than an in-memory enqueue, are
  the recovery source of truth. See [ONBOARDING_OPERATIONS.md](ONBOARDING_OPERATIONS.md),
  [CUSTOM_DOMAIN_OPERATIONS.md](CUSTOM_DOMAIN_OPERATIONS.md), and
  [docs/master-storage-operations.md](docs/master-storage-operations.md).

## Smoke matrix

Run appropriate checks in a non-production or approved isolated environment;
do not use a smoke to create unreviewed production side effects.

| Area | Check |
|---|---|
| Database/migrations | migration acceptance, `migrate`, then `verify-schema` |
| Queue | `queue:smoke` with required session configuration |
| Provider-independent video flows | upload, webhook, embed, library, folders, bulk-video, thumbnail smokes |
| Tenancy/onboarding | `onboarding:smoke` (injected fake provider and queue only) |
| Billing | `billing:smoke`; live lifecycle is a separate blocker below |
| Analytics/audit | `analytics:smoke` and `audit:smoke`; review [ANALYTICS_OPERATIONS.md](ANALYTICS_OPERATIONS.md) and [AUDIT_OPERATIONS.md](AUDIT_OPERATIONS.md) |
| Domains | `custom-domain:smoke` (injected DNS resolver only) |
| Master archive | `cold-master:smoke` and `master-storage:lifecycle-smoke` (test seams only) |

## External blockers — do not infer readiness

These items are separate from application readiness. Keep their features
disabled or fail-closed until they are validated.

- **Bunny:** validate account/library provisioning, upload, playback, webhook,
  deletion, and the adapter round trip with authorized production operations.
  An absent Bunny account key registers an unconfigured adapter; there is no
  production fake fallback.
- **Stripe live lifecycle:** validate approved live catalog/webhook and payment,
  recovery, downgrade, cancellation, reconciliation, and dead-letter handling.
  Follow [STRIPE_OPERATIONS.md](STRIPE_OPERATIONS.md); the test seed is not a
  live setup procedure.
- **Custom-domain TLS/edge:** DNS verification establishes ownership only.
  Certificate issuance, edge routing, and traffic activation remain external.
  See [CUSTOM_DOMAIN_OPERATIONS.md](CUSTOM_DOMAIN_OPERATIONS.md).
- **Cold storage/provider transfer:** both explicit adapters must be configured
  and independently validated. Archive/restore remains unavailable otherwise.
  See [docs/master-storage-operations.md](docs/master-storage-operations.md).

The application may launch only with every feature corresponding to an
unavailable integration disabled or demonstrably fail-closed. Do not advertise
or enable a pending external capability based solely on configuration presence.

## Go/no-go and rollback gates

**Go** only when migration verification, required local configuration, security
checks, worker/queue health, applicable smoke checks, and the selected
integration feature gates are all recorded as passing.

**No-go** when a ledger/catalog mismatch, RLS/grant/audit concern, required
configuration gap, unhealthy queue, unexplained reconciliation state, or an
enabled but unvalidated external feature remains.

Before traffic enablement, identify the last known-good application release,
confirm that rollback does not require reversing an applied migration, and
preserve the ledger and evidence. If a gate fails after rollout, stop further
rollout and disable affected writes/features first. Roll back application code
only when compatible with the migrated schema; use a reviewed forward migration
for schema correction rather than destructive reversal.