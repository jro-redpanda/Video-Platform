---
name: Billing lifecycle integrity
description: Durable concurrency and Stripe-customer recovery rules for tenant billing.
---

Checkout creation, subscription reconciliation, terminal resubscription, and customer repair must share one per-organization lifecycle lock. Only an authoritatively canceled subscription may start a replacement Checkout; live, incomplete, past-due, paused, and unpaid subscriptions must remain fail-closed.

**Why:** Separate Checkout/reconciliation locks allowed a paid-state transition to race a second payable session. Treating every retained subscription ID as live then blocked canceled tenants from resubscribing.

**How to apply:** Any future billing mutation that can create, replace, or adopt a Stripe customer/session/subscription must participate in the same tenant lifecycle serialization and re-read authoritative state after acquiring it.

Stripe Customer creation idempotency must be scoped to a durable, monotonically increasing customer generation. Missing/deleted customer recovery must search exact tenant metadata first, quarantine ambiguous or cross-tenant matches, then advance the generation before creating a replacement.

**Why:** Stripe may replay the original Customer for a cached idempotency key even after that Customer was deleted, trapping the tenant on a stale ID.

**How to apply:** Never reuse one eternal customer-create key per organization. Persist the generation/claim before the provider call, reuse it for same-attempt retries, and advance it exactly once after authoritative deletion.

Verified webhook delivery must be represented by payload-free, leased receipts that retain normalized provider object/customer/subscription/Checkout Session IDs. A receipt may select a tenant only through current application-owned bindings; metadata is only a consistency assertion. Every delivery, including duplicates and older events, reconciles current provider authority rather than applying payload state.

**Why:** Concurrent duplicates can steal unfinished work without token-conditioned leases, and events may arrive before Checkout/subscription bindings commit. Retaining only the event’s primary object also makes invoice recovery impossible because its tenant binding lives on customer/subscription IDs.

**How to apply:** Use short claim leases and token-conditioned completion; retry temporarily unbound receipts for a bounded window; quarantine ambiguous, changed, or disappeared bindings; never persist full provider payloads.

Provider availability failures and billing-integrity failures require different outcomes. Availability failures must preserve the last authoritative access projection and reach queue retry/dead-letter handling. Unknown prices/statuses, ambiguous objects, or tenant/customer mismatches must commit quarantine before the original error leaves the transaction.

**Why:** Revoking access during an outage harms valid subscribers, while throwing from inside the diagnostic transaction silently rolls back the quarantine that operators depend on.

**How to apply:** Classify failures before projection changes, commit safe diagnostics first, and throw retryable failures only after the transaction commits. Persist and verify downgrade schedule identity, but a missing schedule alone must not revoke otherwise-authoritative paid access.