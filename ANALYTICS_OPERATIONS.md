# Analytics operations

## Playback grants and privacy

Public metadata for a ready public/unlisted owned video issues a versioned HMAC grant valid for 30 minutes. Signing and rate-dimension keys are independently derived from `SESSION_SECRET` with HKDF. Rotating `SESSION_SECRET` immediately invalidates all outstanding grants; deploy rotation when that interruption is acceptable. Grants bind the organization, owned video UUID, embed identity, and embed generation. The API revalidates all of these under tenant RLS on every batch and never accepts an organization or video identifier from the client.

IP addresses and grants are never persisted. Rate-limit dimensions are normalized and HMAC-hashed before storage. Do not log playback grants, decoded claims, raw IP addresses, or signing material.

## Limits

Batches contain 1–50 events for one grant/video. Default one-minute windows allow 120 requests/1,500 events per hashed IP and 60 requests/750 events per hashed grant/video. A rejection returns `429 analytics_rate_limited` and `Retry-After`. Tune defaults in `defaultAnalyticsLimits` only with capacity and abuse review. Alert on sustained 429 rates, ingestion 5xx responses, dirty-day age over ten minutes, repeated dirty-day attempts, and retention failures.

## Metrics

Days use UTC. A modern play is exactly one session with a `load` at or before its `play`, no pre-play progress/pause/end lifecycle signal, a maximum four-hour event span, stable credible duration, and no impossible position jump. The signed grant is already bound to one owned video; when that video has a known duration, client duration must remain within five seconds of it. For videos without known duration, reported session duration must be positive and stable within five seconds. A day with no eligible modern play uses the migration-only fallback of distinct `load` sessions as plays; that fallback never produces completions. Thus the eligible completion set is always a subset of the eligible play set.

A completion is an eligible modern play with a post-play `ended`, or post-play position at least 90% of a credible duration. Completion rate is completions divided by plays and is weighted by plays when combined. One session contributes at most one play and one completion.

Watch seconds are computed from ordered eligible-session positive position deltas. Each delta is capped by elapsed wall time and remaining credible media duration; the complete session is also capped by media duration and session wall time. Duplicate IDs are excluded at ingestion and out-of-order data is deterministically ordered by occurrence time and event UUID. Raw valid late/reordered events are retained; credibility is evaluated at full recomputation, never arrival order. Rollups are complete recomputations, never blind increments.

Public grants cannot prove a human watched a video. HMAC binding, rate limits, and deterministic lifecycle plausibility limit simple inflation but are not bot-proofing; treat analytics as product telemetry rather than fraud-grade proof.

Each grant includes an unguessable nonce which is HMAC-hashed before storage. One nonce can attest exactly one client session UUID, and the first batch must include a load; later offline/reordered batches for that established UUID are retained. Attestations record only server receipt times and expire with retention. Completion and watch credit are capped by receipt-time dwell from that load (completion needs at least `max(1 second, min(45% of credible duration, 5 minutes))`), so an instant fabricated load/play/end batch cannot earn completion or watch credit even though raw events remain available for audit/recompute. Public metadata grant minting is additionally rate-limited per hashed IP/video (30/minute by default).

## Worker repair, backfill, and retention

`vid.analytics.rollup` runs each minute. It claims a dirty day with `SKIP LOCKED`, records its version, recomputes, and removes the dirty row only if that version is unchanged. New events during computation increment the version and leave the day queued. Failed rows retain a compact error and retry with backoff.

To backfill, insert/upsert `(organization_id, video_id, day)` into `analytics_dirty_days`, incrementing `version`; do not write rollups directly. To repair a stale claim, clear `claimed_at` and set `available_at=now()` after confirming no active worker. Rollup jobs are idempotent.

`vid.analytics.retention` runs daily. Raw events older than 90 days are removed only when the corresponding rollup exists and the day is not dirty. Rollups are never deleted. Expired rate windows are purged in the same maintenance job. Alert if raw rows older than 92 days grow, but investigate dirty or missing rollups before manual deletion.