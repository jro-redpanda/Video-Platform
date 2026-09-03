---
name: Audit trail integrity
description: Durable rules for tenant audit writes, permissions, pagination, redaction, and export.
---

Tenant audit rows are append-only to the application role. Audit read/export access belongs to groups with both workspace-management and member-management capabilities, not to groups selected by mutable names or descriptions.

**Why:** Mutable display labels are not an authorization boundary, and allowing the application role to update or delete history defeats the audit trail.

**How to apply:** Reconcile audit permissions from durable capabilities, preserve tenant RLS, and reserve deletion for explicit owner-level retention maintenance.

For external provider work, persist the requested intent before the call. Any durable local success or terminal-state transition and its corresponding audit event must commit in the same database transaction.

**Why:** Committing provider state before its audit success event allowed a process crash to leave durable success with no history.

**How to apply:** Use a conditional state transition as the idempotency gate, write the outcome event in that transaction, and do not audit transient retries that made no durable state change.

Audit cursors must be signed and bound to tenant, normalized filters, expiry, and an initial `(createdAt,id)` snapshot. CSV export reuses the same filters, has bounded range/count/rate, and neutralizes spreadsheet formulas.

**Why:** Unscoped cursors leak traversal state across tenants or filters, and CSV cells beginning with formula characters can execute when opened.

**How to apply:** Use stable keyset ordering with a frozen first-page anchor; never use offsets or accept a cursor after filters change.

The audit sanitizer's size limit applies to the combined serialized UTF-8 payload, including keys and JSON framing, after recursive secret redaction.

**Why:** Per-string budgets can still produce oversized rows through many fields, long keys, escaping, or multibyte values.

**How to apply:** Prospectively account for actual serialized bytes and replace excess content with a bounded marker without including raw input in errors.