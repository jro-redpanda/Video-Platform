# Incident response

Use this runbook with [AUDIT_OPERATIONS.md](AUDIT_OPERATIONS.md),
[ONBOARDING_OPERATIONS.md](ONBOARDING_OPERATIONS.md), and the feature
operations documents. Do not run destructive commands, delete evidence, or
clear claims merely to make work run again.

## Severity and roles

| Severity | Meaning | Operating posture |
|---|---|---|
| SEV-1 | Suspected compromise, cross-tenant exposure, widespread unavailable service, or irreversible data risk | Declare incident; contain first; executive decision authority engaged |
| SEV-2 | Major feature or tenant cohort unavailable, material integrity/billing risk, or confirmed provider failure | Incident lead coordinates containment and recovery |
| SEV-3 | Limited tenant/feature degradation with workaround and no evidence of wider exposure | Assigned owner investigates and tracks |
| SEV-4 | Routine defect, alert, or documentation issue | Normal prioritization |

Assign an incident lead, technical lead, communications lead, scribe, and
security/privacy reviewer as applicable. Roles are functions, not personal
contact lists. The incident lead owns severity, scope, and next update; the
scribe maintains timestamps and decisions.

## First 15 minutes

1. Declare severity, open a restricted incident record, assign roles, and state
   the known symptom, time window, affected tenants/features, and uncertainty.
2. Preserve evidence: release revision, request/correlation IDs, safe
   diagnostic codes, job IDs/states, migration ledger/catalog result, and
   relevant audit-event IDs. Do not copy credentials, cookies, tokens, signed
   URLs, raw IPs, grants, webhook bodies, private object keys, or provider
   identifiers into the record.
3. Establish scope with read-only, tenant-scoped queries and safe logs. Treat
   a missing result as unknown, not as proof that an external side effect did
   not occur.
4. Contain the smallest affected capability: fail closed on sensitive writes,
   pause dispatch of new external side effects, or disable a feature gate.
   Preserve reads where safe.
5. Check for cross-tenant impact. If suspected, stop affected access paths and
   engage the security/privacy reviewer immediately.

## Containment and tenant isolation

Maintain tenant boundaries during all investigation and repair. Runtime
transactions require tenant context/RLS; worker access must use only its
documented worker setting and scoped records. Never broaden a query, export, or
temporary permission to “see everything” from an application runtime role.
Validate authorization/RBAC changes against an unaffected tenant before
re-enabling a path.

Pause queues by preventing new dispatch or workers from claiming the affected
operation class, not by deleting PgBoss jobs or durable records. Keep queue
payloads and state evidence. Resume only after idempotency, stale-claim, and
external-side-effect risk are reviewed. A `reconciliation_required` state is a
manual investigation gate, not a retry request.

## Incident classes and immediate checks

| Class | Immediate focus |
|---|---|
| Auth/RBAC | Session/auth behavior, permission decision, RLS scope, memberships; contain cross-tenant or privilege escalation paths |
| Provider | Adapter configuration versus actual reachability, durable provisioning/upload/delete state, safe provider correlation metadata |
| Billing | Webhook delivery, authoritative subscription reconciliation, quarantines, dead letters; never edit `stripe.*` to alter entitlement |
| Playback | Visibility/embed generation, grant validation and rate limits, provider playback health; do not log grants or client IP |
| Analytics | Ingestion errors/429s, dirty-day claims/version, rollup and retention state; preserve raw evidence per [ANALYTICS_OPERATIONS.md](ANALYTICS_OPERATIONS.md) |
| Custom domains | Claim lifecycle and DNS ownership; keep traffic activation disabled because TLS/edge is external |
| Jobs | Queue connectivity, schedule/worker ownership, dead letters, stale claims and durable outboxes |
| Database | Availability, migration ledger/catalog, grants/RLS, transactional integrity; no ad-hoc destructive repair |
| Object storage | Thumbnail/master adapter state, immutable metadata/integrity, cleanup outbox; preserve keys and audit-safe metadata |

For cold masters, distinguish unconfigured adapters from a remotely unhealthy
configured adapter and use [docs/master-storage-operations.md](docs/master-storage-operations.md).

## Evidence, communications, and closure

Audit logs are append-only for the runtime role. Record corrective action as a
new audit event; preserve original audit rows and immutable migration history.
Sanitize every operational artifact under the audit redaction rules.

The communications lead provides impact, mitigation, uncertainty, and next
update through approved internal/customer channels. Do not promise recovery
times not backed by a recorded plan. At closure, document scope, root cause (or
remaining uncertainty), records reconciled, validation performed, customer
impact, and preventive follow-up. Re-enable queues/features gradually and
verify tenant isolation and smoke paths after each step.