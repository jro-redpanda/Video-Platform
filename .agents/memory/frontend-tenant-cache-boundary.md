---
name: Frontend tenant cache boundary
description: Fail-closed rendering and cache isolation rules for auth and workspace identity transitions.
---

Authenticated tenant content must unmount before an auth or workspace identity
change begins, and it must stay gated until the previous tenant's client cache
has been cancelled and cleared and the new identity has been confirmed.
Ambiguous workspace-switch outcomes must reload authoritative workspace state
rather than restoring the old tenant view.

**Why:** Shared query keys can otherwise expose one tenant's cached names,
metrics, permissions, or assets briefly after logout, cross-account login, or a
workspace switch whose network response is lost.

**How to apply:** Treat auth identity and active workspace as cache-boundary
identities. Fail closed during transitions and identity-query failures; do not
use a full-page reload as the security boundary or claim that an ambiguous
switch definitely left the previous workspace active.