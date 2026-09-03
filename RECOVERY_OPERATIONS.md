# Recovery operations

This runbook does not assume automated backups or a particular recovery-point
or recovery-time objective. Coordinate any backup, restore, or point-in-time
recovery (PITR) with the database/platform owner and record the chosen target,
source, authority, and evidence.

## Before recovery

1. Declare the incident and preserve release, migration-ledger, catalog, queue,
   audit, and safe provider-correlation evidence. Follow
   [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).
2. Stop or gate new writes and external-side-effect dispatch only as narrowly as
   needed. Do not delete jobs, truncate tables, rewrite migrations, or erase
   audit data.
3. Inventory the affected tenants, tables, durable intents/outboxes, job
   states, and potentially ambiguous provider operations. A database restore
   can roll back the local record without rolling back a provider action.
4. Validate that the proposed restore source is usable through a documented,
   isolated restore exercise or provider-approved validation. Confirm access,
   integrity, and the exact recovery boundary before production cutover.

## Database and migration controls

After restoration, inspect `public.schema_migrations` and the application
catalog before starting application replicas or workers. The ledger has
raw-byte migration checksums and must agree with the release migration set.
Use the ordered migration contract in [lib/db/MIGRATIONS.md](lib/db/MIGRATIONS.md):
review/accept the catalog, run `migrate` as the schema owner if needed, then
run `verify-schema`. Never edit a recorded checksum or use destructive schema
repair.

PITR requires explicit coordination over the target timestamp and all writes
after it. Reconcile those writes from preserved evidence; do not assume they
were replayed by the recovery mechanism.

## Tenant and audit validation

Before reopening traffic, validate runtime-role grants, RLS policies, and
tenant context with representative authorized and unauthorized accesses in an
isolated check. Verify membership/permission behavior and that tenant-scoped
records remain inaccessible across tenants. Audit rows are append-only:
preserve them, use sanitized new corrective events, and retain exported
evidence according to approved handling. See [AUDIT_OPERATIONS.md](AUDIT_OPERATIONS.md).

## PgBoss and durable-work reconciliation

The queue schema is migration-owned and PgBoss runtime migration is disabled.
After DB recovery, reconcile managed queue state with durable application
records before enabling workers:

- onboarding intents and tenant spaces: repair `pending`, stale dispatch, and
  queued work through the dispatcher; manually investigate
  `reconciliation_required` provider creates;
- embed, thumbnail cleanup, domain verification, analytics dirty days, billing,
  and upload-expiry records: use their durable state/outbox semantics, dead
  letters, and feature runbooks rather than fabricating completions;
- master-storage operations: retain the operation ledger, generation, claim,
  attempts, and idempotency key. Let documented stale handling decide whether a
  repeat is safe; investigate ambiguous target writes manually.

Do not assume a missing queue job means a missing external side effect. Do not
blindly replay provider provisioning, deletion, uploads, billing changes, or
archive/restore transfers. Resolve ambiguity from provider-side evidence and
the owned durable record.

## Cold masters

Pre-integrity archive rows containing only old key/time information are legacy
**unverified** records. They are not restorable until reconciliation records
the required digest, positive size, and content type. A restored archive is
valid only when key, archive time, lowercase SHA-256, positive size, and
content type are complete and verified. Preserve these private fields and do
not expose them in tickets, APIs, or audits. See
[docs/master-storage-operations.md](docs/master-storage-operations.md).

## Post-recovery smoke order

1. Migration ledger/catalog and `verify-schema`.
2. Database connectivity, runtime grants/RLS, authentication/RBAC, and audit
   append-only behavior.
3. Queue connectivity, schedules, durable-state/dead-letter inspection; enable
   dispatch in controlled operation classes.
4. Tenant/onboarding, video/library/embed/thumbnail and analytics/audit
   provider-independent checks.
5. Billing reconciliation and custom-domain ownership checks according to
   their runbooks.
6. Only after separate approval, validate provider, live billing lifecycle,
   custom-domain TLS/edge, and cold-storage/transfer side effects.

Record each gate and reopen writes/features incrementally. If validation fails,
return to containment and preserve the new evidence.