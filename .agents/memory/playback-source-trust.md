---
name: Playback source trust
description: Security invariants for transient provider playback redirects and owned embed origins.
---

Treat every provider playback source as untrusted even after an adapter returns it: require HTTPS, no credentials, custom port, or fragment, a finite expiry with a startup safety margin, and adapter-specific asset trust. After provider I/O, recheck the video’s readiness, visibility where public, tenant/account linkage, and provider identifiers before returning metadata or redirecting.

**Why:** Provider calls create a race window where a video can become private, non-ready, deleted, or relinked. Malformed dates can otherwise bypass simple comparisons, and nearly expired manifests can fail before playback starts.

**How to apply:** Use the same validator for public and authenticated metadata/source paths. Keep owned public URLs canonical through an explicit HTTPS production origin, and apply no-store plus no-referrer policy to successful and failed playback responses.