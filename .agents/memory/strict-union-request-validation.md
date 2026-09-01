---
name: Strict union request validation
description: Preserve exact HTTP body semantics when generated Zod union objects strip unknown keys.
---

For mutually exclusive OpenAPI request bodies, use a required discriminator and retain an explicit raw-body allowed-key and discriminator/payload agreement guard at the HTTP boundary.

**Why:** Orval's generated Zod object unions strip unknown properties by default even when OpenAPI declares `additionalProperties: false`. Without the raw guard, a request containing both operation payloads can parse as the first union member after silently discarding the other field.

**How to apply:** Whenever a generated union represents exactly one operation, test both, neither, wrong-discriminator, unknown-key, duplicate, and oversize bodies directly against the endpoint. Do not remove the boundary guard merely because generated TypeScript is a discriminated union.