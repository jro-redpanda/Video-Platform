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

Preserve legacy key/time-only archive rows as visible but unverified and non-restorable until a verified archive is produced.

**Why:** Migration backfills cannot reconstruct a historical object's content identity safely.

**How to apply:** Status may report the legacy archive, but restore eligibility requires the full verified metadata set; never invent hashes, sizes, or content types during migration.