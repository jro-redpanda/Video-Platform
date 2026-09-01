---
name: Better Auth Drizzle compatibility
description: Version-sensitive schema and package-resolution constraints for Better Auth with Drizzle.
---

Match the authentication tables to the installed Better Auth runtime metadata rather than older documentation or a mismatched CLI.

**Why:** The current runtime added account schema requirements absent from older examples, and pnpm can instantiate identical Drizzle versions under different peer contexts, producing incompatible private SQL types.

**How to apply:** Inspect the installed runtime's core table metadata when schema validation fails. Keep Kysely peer context consistent at the shared database package, and verify both type-checking and a real sign-up/session round trip after dependency changes.