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
Processing work stale for ten minutes becomes retryable `failed` when attempts
remain; at the attempt limit it becomes `reconciliation_required`. Retryable
failed work at the attempt limit becomes non-retryable terminal `failed`.
Retryable failures use the persisted retry timestamp and stop after eight
attempts. Definitive failures have one terminal audit event. Do not manually
clear an archived video's private master key when a restore fails.

For investigation use the tenant-scoped status endpoint and the operation
ledger under a worker DB setting. Storage keys, provider identities, and
claims are private and must not be copied into tickets, audit metadata, or API
responses. `reconciliation_required` is reserved for outcomes that cannot be
safely replayed; ordinary interrupted archive/restore work is idempotently
replayed. Archive source streams and restore streams must be fully consumed
exactly once, with byte count and SHA-256 matching their declared metadata.
Storage and target-transfer results must attest the same key, type, size,
digest, and durable idempotency key before completion. A partial stream or
lying metadata is terminal `integrity_mismatch`; an ambiguous target write
must be `reconciliation_required`, never completed.

An archived video is restorable only with the complete verified private set:
key, archive time, lowercase SHA-256, positive size, and content type.
Pre-0032 key/time-only archive rows are intentionally preserved as legacy
unverified records, but are not restorable until a reconciliation job records
their integrity metadata. These private fields and restore snapshots never
appear in APIs or audit events.