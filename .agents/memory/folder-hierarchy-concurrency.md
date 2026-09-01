---
name: Folder hierarchy concurrency
description: Concurrency rule for folder structure and content-membership mutations.
---

Every mutation that creates, moves, deletes, adds content to, or removes content from the folder hierarchy must share the same organization-scoped transaction lock.

**Why:** Empty-only deletion and hierarchy validation are multi-statement invariants. Locking only folder CRUD still permits a concurrent content move to race the empty check, leaving a foreign-key error to surface instead of a deterministic not-found or conflict response.

**How to apply:** When adding bulk moves, imports, restores, or other folder assignment paths, acquire the hierarchy lock before destination validation and hold it through the membership write and audit record. Add a race test that accepts only the valid serialized outcomes.