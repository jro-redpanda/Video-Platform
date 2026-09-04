---
name: App Storage thumbnail promotion
description: Undocumented metadata behavior observed when promoting signed-upload candidates into immutable App Storage objects.
---

Do not assume an App Storage/GCS object copy preserves requested Content-Type metadata. Copy the exact validated source generation to a create-only destination, then patch destination metadata with generation and metageneration preconditions. Revalidate type, size, and magic bytes before committing, persist the final generation, and always serve that exact generation.

**Why:** A live signed JPEG upload copied the correct bytes and size but produced a destination with no Content-Type, causing finalize to fail despite fake-adapter tests passing.

**How to apply:** Use this pattern for thumbnail or media promotion flows that move browser-uploaded candidates into server-owned immutable keys. Keep a real App Storage round-trip smoke test alongside fake storage tests.

Never make candidate cleanup eligible until its signed PUT capability has expired with clock-skew margin. Before every object deletion, validate that the key belongs to the recorded tenant, lock the encoded owner row, and recheck that the key is not current.

**Why:** Immediate candidate deletion lets a still-valid signed PUT recreate an orphan. Delayed compensation cleanup can also overlap a long-running finalize and delete the object just before it becomes current.

**How to apply:** Schedule candidates beyond signed expiry, give retired finals a short in-flight-read grace, quarantine malformed/cross-tenant keys, and defer referenced objects without consuming retry budget.