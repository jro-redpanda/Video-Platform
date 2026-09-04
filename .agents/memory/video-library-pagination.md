---
name: Video library pagination
description: Integrity and consistency rules for tenant-scoped, cursor-paginated video listings.
---

Library cursors must be authenticated opaque tokens, bound to the tenant and normalized filter/sort scope. When membership or ordering depends on mutable fields, timestamp high-water marks are insufficient: later pages must read a durable frozen projection and total established by the first page.

**Why:** Base64 encoding does not prevent cursor tampering. Title, filter, analytics, folder, and delete mutations can duplicate, omit, or reorder rows even when later inserts are excluded by a creation-time watermark.

**How to apply:** Freeze only the redacted response projection, bind each signed cursor to tenant/scope/snapshot/position/expiry, expire snapshots quickly, and serialize per-tenant admission before enforcing a hard active-snapshot cap.

Client pagination must explicitly reset and rehydrate its first page after create/delete mutations.

**Why:** Invalidating only the active cursor query leaves accumulated rows stale, while clearing local rows can produce a false empty state when structural sharing preserves an unchanged first-page response reference.

**How to apply:** Cancel and remove the whole list query family before clearing the cursor and accumulated traversal, then trigger deterministic first-page rehydration even when the current cursor was already empty.