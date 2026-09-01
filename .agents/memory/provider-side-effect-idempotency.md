---
name: Provider side-effect idempotency
description: Rules for safely retrying provider creates and Postgres-backed outbox dispatch.
---

Persist an exclusive claim before any provider create call that has no upstream idempotency key. If the process loses the outcome and no provider ID was durably stored, require reconciliation instead of automatically issuing another create.

**Why:** A retry after an ambiguous external outcome can create duplicate libraries or assets even when the local database operation is idempotent.

**How to apply:** Separate definitive rejection, safe pre-call failure, and ambiguous post-call failure. Only the first two may release or retry automatically.

Outbox dispatch must use a deterministic queue job ID. Automatic repair is allowed only while the queue guarantees that identity is still retained; older send-before-mark ambiguity must be quarantined rather than re-enqueued.

**Why:** After queue retention expires, absence of the old job no longer proves it was never accepted or executed.

**How to apply:** Keep the repair horizon shorter than queue retention and route older stale dispatch claims to reconciliation. Downstream external writes should also be idempotent.