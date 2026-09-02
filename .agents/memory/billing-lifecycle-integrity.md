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