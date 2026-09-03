---
name: Analytics telemetry integrity
description: Durable integrity boundaries for public playback telemetry, rollups, and browser retry queues.
---

Public playback telemetry must use one server-attested client session per signed grant. Credited watch time is bounded by media-position and server-receipt elapsed time; completion requires an eligible load-to-play lifecycle, sufficient server dwell, and a terminal position at or above 90% of credible duration.

**Why:** Client timestamps and lifecycle events are attacker-controlled. Shape validation and rate limits alone allowed instant fabricated sessions and low-position ended events to inflate metrics.

**How to apply:** Preserve signed grant binding, hashed grant identity, one-session-per-grant attestation, persistent issuance/event limits, deterministic event-time ordering, receipt-time caps, and the 90% completion threshold. Describe the result as abuse-resistant telemetry, never proof of a human viewer.

Queued browser events must be persisted as independent keys scoped by owned video UUID and event UUID. Never store grants, tenant IDs, or provider IDs, and never use one aggregate read-modify-write queue shared across tabs or videos.

**Why:** Aggregate queues allowed one video's grant to submit another video's events and allowed concurrent tabs to overwrite or delete unrelated pending telemetry.

**How to apply:** Add/remove only exact event keys, rely on server event-ID deduplication for overlapping flushes, and evict only the oldest events within the same video's bounded queue.