# Master archive operations

The master archive control plane is durable but is fail-closed by default.
`storageConfigured` and `sourceTransferConfigured` describe adapter
configuration only; neither is an external health check.

When either flag is false, archive and restore requests return
`503 MASTER_STORAGE_UNAVAILABLE`. No operation or audit event is created.
Configure both explicit adapters before accepting work; there is no fallback
object store or provider implementation.

Accepted work is recorded in `master_storage_operations`. The dispatcher
claims `pending`, eligible retryable `failed`, or stale `dispatching` work and
increments its dispatch generation before publishing the generation-qualified
job ID `{operationId}:{generation}` (with the same pair as job data). A failed
publish becomes retryable. A `queued` job stale for ten minutes returns to
`pending`; its next claim receives a new generation. A `dispatching` claim
stale for five minutes is claimable again and also receives a new generation.
Processing work stale for thirty-five minutes becomes retryable `failed` when attempts
remain; at the attempt limit it becomes `reconciliation_required`. Retryable
failed work at the attempt limit becomes non-retryable terminal `failed`.
Retryable failures use the persisted retry timestamp and stop after eight
attempts. Definitive failures have one terminal audit event. Do not manually
clear an archived video's private master key when a restore fails.

One video may have only one outstanding master operation, where outstanding
includes pending/dispatching/queued/processing work and retryable failure.
Idempotency binds the organization, video, operation, provider account,
provider tenant space, provider asset, and restore storage key. Video deletion
is blocked while master work remains outstanding. Workers verify that the
captured provider identity still owns the video before I/O and again under the
completion transaction; a deletion or provider relink during I/O moves the
operation to `reconciliation_required` instead of attaching stale bytes or
reporting a restore complete.

For investigation use the tenant-scoped status endpoint and the operation
ledger under a worker DB setting. Storage keys, provider identities, and
claims are private and must not be copied into tickets, audit metadata, or API
responses. `reconciliation_required` is reserved for outcomes that cannot be
safely replayed; ordinary interrupted archive/restore work is idempotently
replayed. Archive source streams and restore streams must be fully consumed
exactly once, with byte count and SHA-256 matching their declared metadata.
Provider source adapters must attest the exact requested provider account,
tenant space, and asset. Their size must be a positive safe integer, their
digest canonical lowercase SHA-256, and their trimmed content type free of
control characters. When immutable upload metadata exists, provider source
size and content type must match it before storage I/O begins. Stream chunks
must be non-empty `Uint8Array` values, may never exceed the declaration, and
the underlying iterator must be closed when a downstream consumer stops early.

Storage and target-transfer results must attest the same identity, key, type,
size, digest, and durable idempotency key before completion. A partial archive
stream or lying storage metadata is terminal `integrity_mismatch`. Once
`restoreToTarget` starts, an unknown error, an explicit ambiguous-result error,
a partial stream, or incorrect target attestation is
`reconciliation_required`, never automatically retried. A transfer adapter may
throw its transient, unavailable, or definitive-rejection errors after that
point only when it can prove the target accepted no write.

An archived video is restorable only with the complete verified private set:
key, archive time, lowercase SHA-256, positive size, and content type.
Pre-0032 key/time-only archive rows are intentionally preserved as legacy
unverified records, but are not restorable until a reconciliation job records
their integrity metadata. These private fields and restore snapshots never
appear in APIs or audit events.

## Externally gated production work

The repository still has no production cold-master storage adapter or provider
master export/import adapter. Completing production readiness requires:

- configuring a durable cold tier with conditional content-addressed writes,
  retention, encryption, integrity verification, and restore retrieval;
- implementing and validating provider transfer adapters, including accepted
  write ambiguity and cancellation behavior;
- proving at least one replacement provider restore path rather than only the
  current provider;
- running credentialed archive/restore round trips, retention/DR exercises,
  and cost/throughput validation in the intended production environment.

Do not interpret the local in-memory conformance smoke or configured-status
flags as evidence that these operational gates have passed.