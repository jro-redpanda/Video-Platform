---
name: Custom-domain trust boundary
description: Separates DNS ownership proof from certificate, routing, and destination trust.
---

An exact DNS TXT challenge proves control of a hostname only. Do not require A/AAAA
records for ownership while custom-domain traffic is not active, and never use verified
ownership as authorization to connect or route.

**Why:** Pre-activation customers may publish only the TXT record, while DNS answers can
change after verification. Coupling these checks either blocks valid ownership or creates a
false promise that a one-time DNS result makes future traffic safe.

**How to apply:** Any future certificate or edge-routing integration must independently
resolve and validate destinations at each connection boundary, including after DNS refreshes
and redirects, and reject private or special-use addresses there.