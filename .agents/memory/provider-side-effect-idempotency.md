---
name: Provider side-effect idempotency
description: Rules for provider create/delete ownership, safe retries, and Postgres-backed outbox dispatch.
---

Persist an exclusive claim before any provider create call that has no upstream idempotency key. If the process loses the outcome and no provider ID was durably stored, require reconciliation instead of automatically issuing another create.

**Why:** A retry after an ambiguous external outcome can create duplicate libraries or assets even when the local database operation is idempotent.

**How to apply:** Separate definitive rejection, safe pre-call failure, and ambiguous post-call failure. Only the first two may release or retry automatically.

Provider creation and deletion ownership must be mutually exclusive at every asynchronous boundary: before acquiring a create claim, after the provider returns, and before activating the local resource.

**Why:** Guarding only the provider call or final write leaves race windows where deletion can finish but a delayed initializer still creates an orphan or resurrects terminal state.

**How to apply:** Revalidate session identity, eligible lifecycle state, and absence of deletion/reconciliation ownership on each pre-side-effect and post-side-effect transition. A lost claim must not call the provider or overwrite terminal state.

Outbox dispatch must use a deterministic queue job ID. Automatic repair is allowed only while the queue guarantees that identity is still retained; older send-before-mark ambiguity must be quarantined rather than re-enqueued.

**Why:** After queue retention expires, absence of the old job no longer proves it was never accepted or executed.

**How to apply:** Keep the repair horizon shorter than queue retention and route older stale dispatch claims to reconciliation. Downstream external writes should also be idempotent.

Persist a deletion claim before asking a provider to delete an asset. Delete owned metadata only after provider deletion is confirmed; an ambiguous provider outcome keeps the owned record and enters reconciliation instead of retrying.

**Why:** Repeating an ambiguously completed provider delete can hide a real external success behind a later not-found response, while deleting local metadata first destroys the information needed to reconcile.

**How to apply:** Provider-backed delete flows are provider-first and fail closed. Local-only records may be deleted transactionally without an external claim.

Treat required provider callback configuration as part of tenant-space provisioning, under the same exclusive external-call claim. Persist the remote space identity before configuring the callback, and release the claim only after durable callback state is recorded.

**Why:** Activating a tenant after library creation but before callback readiness produces a false-ready workspace, while replaying creation after an uncertain callback outcome can duplicate the remote library.

**How to apply:** Distinguish a definite callback rejection from transport/timeout ambiguity for diagnostics, but keep both inactive because the remote space exists. Unknown callback state must block provisioning finalization.