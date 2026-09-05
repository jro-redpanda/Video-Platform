---
name: Cold-master operation integrity
description: Durable delivery and end-to-end identity rules for archive and restore operations.
---

Use a new dispatch generation in every retried cold-master queue job identity; a retained completed job from an earlier generation must never suppress later delivery.

**Why:** Durable queues retain completed job IDs, so reusing an operation-only ID can make a repair look dispatched while no worker can receive it.

**How to apply:** Persist the generation before enqueueing, include it in the queue job ID, and let enqueue failure return the operation to delayed dispatch without consuming an execution attempt.

Treat archive and restore completion as verified byte-transfer outcomes. Count and SHA-256 the consumed stream, require exact immutable key/size/content-type/SHA snapshots, and require the restore target to attest the durable idempotency key plus the same metadata.

**Why:** A provider, storage adapter, or restore target can partially consume a stream or return plausible but false metadata; completing on that basis would silently lose or corrupt the master.

**How to apply:** Keep provider/storage calls outside database transactions, compare every attested value before the atomic completion update, and terminalize integrity mismatches instead of publishing success.

Treat retryable failure as outstanding work, and bind each operation to the
full organization/video/provider snapshot. Block video deletion while work is
outstanding, then recheck the exact provider identity and deletion state before
I/O and again under the completion transaction.

**Why:** Active-only uniqueness lets a changed provider identity create a
second operation while an earlier retry is still eligible; deletion or relink
during external I/O can otherwise attach old-provider bytes or falsely report
a restore complete.

**How to apply:** Include organization, provider account, tenant space, asset,
and restore key in idempotency; permit one active-or-retryable operation per
video; quarantine completion when the captured video snapshot no longer
matches, preserving private result evidence for reconciliation.

Once a restore target write begins, unknown outcomes and incorrect target
attestation require reconciliation rather than automatic retry.

**Why:** The provider may have accepted the write even when the response,
stream verification, or returned target identity is missing or wrong. Replaying
could overwrite or duplicate provider state.

**How to apply:** Let transfer adapters use transient/unavailable/definitive
errors after write start only when they prove no write was accepted. Close
source iterators on early downstream termination, and require exact,
safe-integer metadata before starting storage I/O.

Preserve legacy key/time-only archive rows as visible but unverified and non-restorable until a verified archive is produced.

**Why:** Migration backfills cannot reconstruct a historical object's content identity safely.

**How to apply:** Status may report the legacy archive, but restore eligibility requires the full verified metadata set; never invent hashes, sizes, or content types during migration.