---
name: Build checkpoints and portability
description: Review gates and architectural boundaries for the video platform build.
---

Stop for user review after the RBAC engine, provider adapter, and player/embed milestones. Do not build beyond each gate until the user confirms.

**Why:** These are hard dependency boundaries, and the user wants to inspect each before downstream work compounds a mistake.

**How to apply:** At the provider checkpoint, request Bunny credentials and require a real create/upload/webhook/HMAC round trip. Keep the provider interface capability-based and keep Bunny concepts inside its adapter. Treat owned IDs, embeds, player, and analytics—not R2—as portability.

Cloudflare is not needed until cold-master storage work. When requested, scope access to R2 only; custom-domain DNS grants are a separate later decision.