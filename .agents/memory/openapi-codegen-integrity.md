---
name: OpenAPI codegen integrity
description: Non-obvious boundaries and reproducibility rules for the product OpenAPI and Orval outputs.
---

Document provider-owned and internal ingress in the authoritative OpenAPI, but mark fixed internal operations so the input transformer removes them before product-client generation. Keep dynamic provider-owned route families documented as boundaries rather than inventing fixed operations.

**Why:** Incoming webhook/test callbacks and authentication routes must not be invisible to route-parity review, but generating consumer hooks for those server-owned endpoints is misleading and unsafe.

**How to apply:** Any new runtime route must either generate a product client or carry an explicit internal/provider-owned boundary in the same contract and remain absent from generated clients.

Keep Orval Zod index generation disabled while operation validators and generated schema types share an output workspace.

**Why:** An operation with both path and query parameters can make Orval emit the same exported name for a Zod parameter validator and a generated TypeScript parameter type; the generated barrel then fails typechecking. Regenerating also rewrites that barrel, so a hand-maintained export fix is not durable.

**How to apply:** Preserve the no-index generator setting unless the outputs are moved to non-conflicting barrels. Verify changes by comparing a disposable regeneration byte-for-byte and by checking runtime method/path parity against OpenAPI.