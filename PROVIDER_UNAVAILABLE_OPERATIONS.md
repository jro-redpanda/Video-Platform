# Provider-unavailable operations

## Configuration is not health

Adapter configuration says only that local configuration selected an adapter; it
does not prove credentials, remote reachability, capacity, or provider health.
Conversely, a configured-looking database account must not be treated as
operational without safe validation.

Current production behavior is explicitly fail-closed:

- Bunny is registered as an unconfigured provider when `BUNNY_API_KEY` is
  absent. It does not fall back to the test fake.
- `secondary` is always registered as an unconfigured provider.
- Test-only fake providers are available only in the test runtime.

Do not retry by adding credentials to requests, logs, tickets, or environment
files. Correct configuration through the approved secret/configuration path,
then use a controlled validation. Credentials and decrypted provider metadata
remain private.

## User/API behavior while unavailable

- Onboarding accepts and durably records the local request before provider
  work; it is not proof that a remote library exists. Provider resolution or
  capacity failure before a remote call transitions the intent to
  `unavailable`; the owner may retry after correction.
- Provider-backed upload initiation/finalization and playback must reject or
  remain unavailable when the selected provider cannot safely serve them. Do
  not manufacture upload URLs, assets, playback sources, or a ready status.
- Deletion/expiry cleanup that cannot establish the provider outcome must
  preserve the record and use reconciliation rather than falsely reporting a
  completed remote deletion.
- Cold archive/restore returns unavailable when either cold-storage or
  provider-transfer adapter is unconfigured. No archive operation/audit is
  created for that rejected request.

UI/API messaging should say the capability is unavailable or pending
reconciliation without exposing provider credentials, IDs, raw errors, or
internal diagnostic detail.

## Operator triage

1. Establish affected tenant, feature, time window, release, provider key,
   durable intent/operation/job IDs, state, attempt count, and safe diagnostic
   code. Use tenant-scoped reads and approved non-secret metadata only.
2. Determine whether failure occurred before a remote call, was a definite
   rejection, or has an ambiguous outcome. Do not infer absence of a remote
   side effect from a timeout, worker crash, or missing job.
3. Inspect owned `provider_tenant_spaces` and the corresponding onboarding or
   video lifecycle record. Keep remote identifiers and encrypted material out
   of tickets and public responses.
4. Check worker/queue health, stale claims, dead letters, provider capacity,
   and whether configuration is merely present versus validated healthy.
5. Gate new affected work, preserve safe reads, and escalate to provider
   support through approved channels when remote evidence is required.

## Durable states and recovery

Onboarding `pending`, `dispatching`, and `queued` are dispatcher-repairable;
dispatch/user retries are bounded. A pre-call unavailability can be retried
after correction. A definite rejection is a safe failed state. An interrupted
or ambiguous external create is `reconciliation_required` and is **never**
automatically replayed. Inspect provider-side evidence and the owned space
record, reconcile manually, and never clear an external-call claim merely to
force a replay. Details are in
[ONBOARDING_OPERATIONS.md](ONBOARDING_OPERATIONS.md).

Apply the same principle to upload/delete and other provider side effects:
repeat only operations whose idempotency and prior outcome are established.
Quarantine uncertain work and retain its durable state, job evidence, and
sanitized audit trail. Use [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) for
containment and [RECOVERY_OPERATIONS.md](RECOVERY_OPERATIONS.md) after a
database/queue recovery.

## Validation split

These tests need no provider credentials and may run in an isolated test
environment: onboarding smoke (injected fake provider/queue), upload/webhook/
embed/library/folder/bulk/thumbnail lifecycle smokes, queue smoke, and
provider-independent audit/analytics/domain/master-storage lifecycle tests.
They prove local contracts, not provider availability.

Defer until valid, approved credentials and a controlled external environment
are available: Bunny adapter round trip, tenant-library provisioning, direct
upload, playback, webhook delivery, deletion, and capacity behavior. Treat
Stripe live lifecycle, custom-domain TLS/edge, and cold provider transfer as
separate integrations; their readiness is not established by provider-free
tests.