---
name: Build checkpoints and portability
description: Review gates and architectural boundaries for the video platform build.
---

Stop for user review after the RBAC engine, provider adapter, and player/embed milestones. Do not build beyond each gate until the user confirms.

**Why:** These are hard dependency boundaries, and the user wants to inspect each before downstream work compounds a mistake.

**How to apply:** At the provider checkpoint, request Bunny credentials and require a real create/upload/webhook/HMAC round trip. Keep the provider interface capability-based and keep Bunny concepts inside its adapter. Treat owned IDs, embeds, player, and analytics—not R2—as portability.

Cloudflare is not needed until cold-master storage work. When requested, scope access to R2 only; custom-domain DNS grants are a separate later decision.

The owned embed boundary is the stable `/v/{owned-video-uuid}` iframe. Copied customer markup must contain only that owned URL; the iframe may call owned API routes to resolve an expiring provider manifest through the adapter. Public JSON returns an owned relative source route, and the provider URL appears only as a short-lived, no-store redirect target.

**Why:** The PRD explicitly requires the owned embed page to resolve playback through the provider adapter. Fully static manifests conflict with expiring signed playback, while exposing provider URLs in copied markup would break portability.

**How to apply:** Treat “zero control-plane requests” as no direct API integration from the customer’s host page beyond loading the owned iframe. Keep provider identities and URLs out of embed HTML and metadata responses.