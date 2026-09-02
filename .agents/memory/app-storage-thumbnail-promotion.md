---
name: App Storage thumbnail promotion
description: Undocumented metadata behavior observed when promoting signed-upload candidates into immutable App Storage objects.
---

Do not assume an App Storage/GCS object copy preserves requested Content-Type metadata. Copy the exact validated source generation to a create-only destination, then patch destination metadata with generation and metageneration preconditions. Revalidate type, size, and magic bytes before committing, persist the final generation, and always serve that exact generation.

**Why:** A live signed JPEG upload copied the correct bytes and size but produced a destination with no Content-Type, causing finalize to fail despite fake-adapter tests passing.

**How to apply:** Use this pattern for thumbnail or media promotion flows that move browser-uploaded candidates into server-owned immutable keys. Keep a real App Storage round-trip smoke test alongside fake storage tests.