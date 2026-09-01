---
name: Video library pagination
description: Integrity and consistency rules for tenant-scoped, cursor-paginated video listings.
---

Library cursors must be authenticated opaque tokens, bound to the tenant and normalized filter/sort scope. The first page establishes a high-water snapshot and total in one repeatable-read transaction; later pages enforce that snapshot and reuse its total.

**Why:** Base64 encoding does not prevent cursor tampering, and recomputing totals or admitting later inserts causes duplicate, omitted, or internally inconsistent multi-page results.

**How to apply:** Use deterministic keyset tie-breakers, purpose-derived HMAC keys, timing-safe verification, canonical encodings, bounded expiry, and non-leaking 400 responses for invalid cursors.

Client pagination must explicitly reset and rehydrate its first page after create/delete mutations.

**Why:** Invalidating only the active cursor query leaves accumulated rows stale, while clearing local rows can produce a false empty state when structural sharing preserves an unchanged first-page response reference.

**How to apply:** Clear the cursor and accumulated traversal, invalidate the whole list query family, and trigger deterministic first-page rehydration even when the current cursor was already empty.