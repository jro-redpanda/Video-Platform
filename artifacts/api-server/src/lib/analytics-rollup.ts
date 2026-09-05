import { and, eq, sql } from "drizzle-orm";
import {
  analyticsDirtyDaysTable,
  analyticsPlaybackSessionsTable,
  analyticsRateWindowsTable,
  playbackEventsTable,
  videoAnalyticsRollupsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { withWorkerDb } from "./worker-db";

type DirtyDay = { organizationId: string; videoId: string; day: string; version: number; attempts: number };

export async function claimAnalyticsDirtyDay(now = new Date()): Promise<DirtyDay | undefined> {
  return withWorkerDb("analytics", async (tx) => {
    const result = await tx.execute<DirtyDay>(sql`
      select organization_id as "organizationId", video_id as "videoId", day::text as day,
        version::int as version, (attempts + 1)::int as attempts
      from ${analyticsDirtyDaysTable}
      where available_at <= ${now} and (claimed_at is null or claimed_at < ${new Date(now.getTime() - 10 * 60_000)})
      order by available_at, day for update skip locked limit 1
    `);
    const candidate = result.rows[0];
    if (!candidate) return undefined;
    await tx.update(analyticsDirtyDaysTable).set({
      claimedAt: now, attempts: sql`${analyticsDirtyDaysTable.attempts} + 1`, lastError: null,
    }).where(and(
      eq(analyticsDirtyDaysTable.organizationId, candidate.organizationId),
      eq(analyticsDirtyDaysTable.videoId, candidate.videoId),
      eq(analyticsDirtyDaysTable.day, candidate.day),
    ));
    return candidate;
  });
}

/** Complete recomputation makes retries, late events, and out-of-order delivery deterministic. */
export async function recomputeAnalyticsDay(dirty: DirtyDay) {
  try {
    return await withWorkerDb("analytics", async (tx) => {
      const result = await tx.execute<{
        plays: number; uniqueSessions: number; watchSeconds: number; completions: number;
      }>(sql`
        with source as (
          select event.*, video.duration_seconds server_duration, attestation.first_received_at
          from ${playbackEventsTable} event
          join videos video on video.id=event.video_id and video.organization_id=event.organization_id
          join ${analyticsPlaybackSessionsTable} attestation
            on attestation.organization_id=event.organization_id and attestation.video_id=event.video_id
              and attestation.client_session_id=event.session_id and attestation.embed_id=event.embed_id
          where event.organization_id=${dirty.organizationId} and event.video_id=${dirty.videoId}
            and (event.occurred_at at time zone 'UTC')::date = ${dirty.day}::date
        ), shape as (
          select session_id, max(server_duration) server_duration,
            min(first_received_at) attested_at,
            min(occurred_at) filter(where event_type='play') first_play,
            max(occurred_at)-min(occurred_at) session_span,
            min(duration_seconds) filter(where duration_seconds is not null) min_duration,
            max(duration_seconds) filter(where duration_seconds is not null) max_duration,
            bool_or(event_type='load') has_load, bool_or(event_type='play') has_play,
            (min(occurred_at) filter(where event_type in ('progress','pause','ended'))
              < min(occurred_at) filter(where event_type='play')) preplay_lifecycle,
            bool_or(position_seconds > coalesce(nullif(server_duration,0), duration_seconds, 86400) + 5) bad_position
          from source group by session_id
        ), eligible as (
          select shape.*, coalesce(nullif(server_duration,0), max_duration) credible_duration,
            (has_play and has_load and first_play is not null and session_span <= interval '4 hours'
             and not preplay_lifecycle and not bad_position
             and not exists(select 1 from source earlier join source later
               on later.session_id=earlier.session_id
                 and (later.occurred_at, later.event_id) > (earlier.occurred_at, earlier.event_id)
               where earlier.session_id=shape.session_id
                 and later.position_seconds-earlier.position_seconds
                   > extract(epoch from later.occurred_at-earlier.occurred_at)+5)
             and exists(select 1 from source load where load.session_id=shape.session_id
               and load.event_type='load' and load.occurred_at <= shape.first_play)
             and (
               (server_duration > 0 and not exists(select 1 from source e where e.session_id=shape.session_id
                 and e.duration_seconds is not null and abs(e.duration_seconds-server_duration)>5))
               or (server_duration <= 0 and min_duration > 0 and max_duration-min_duration <= 5)
             )) eligible_play
          from shape
        ), ordered as (
          select source.*, eligible.first_play, eligible.attested_at, eligible.credible_duration,
            lag(position_seconds) over(partition by source.session_id order by source.occurred_at,source.event_id) previous_position,
            lag(occurred_at) over(partition by source.session_id order by source.occurred_at,source.event_id) previous_time
          from source join eligible using(session_id)
          where eligible.eligible_play and source.occurred_at >= eligible.first_play
        ), modern as (
          select eligible.session_id,
            (bool_or(ordered.event_type in ('ended','progress')
              and ordered.position_seconds >= ordered.credible_duration*.9)
              and extract(epoch from max(ordered.received_at)-min(ordered.attested_at))
              >= greatest(1, least(coalesce(nullif(max(eligible.server_duration),0), max(ordered.duration_seconds), 86400)*.45, 300))) completion,
            least(coalesce(nullif(max(eligible.server_duration),0),86400), extract(epoch from max(ordered.occurred_at)-min(ordered.occurred_at)),
              extract(epoch from max(ordered.received_at)-min(ordered.attested_at)),
              coalesce(sum(case when ordered.previous_position is null then 0 else greatest(0, least(
                ordered.position_seconds-ordered.previous_position,
                extract(epoch from ordered.occurred_at-ordered.previous_time),
                coalesce(nullif(eligible.server_duration,0), ordered.duration_seconds,86400)-least(ordered.previous_position,coalesce(nullif(eligible.server_duration,0),ordered.duration_seconds,86400))
              )) end),0)) watch_seconds
          from eligible join ordered using(session_id) where eligible.eligible_play
          group by eligible.session_id
        ), aggregate as (
          select count(*)::int plays, count(*)::int unique_sessions,
            floor(coalesce(sum(watch_seconds),0))::int watch_seconds,
            count(*) filter(where completion)::int completions from modern
        ) select aggregate.plays as "plays",
          aggregate.unique_sessions as "uniqueSessions",
          aggregate.watch_seconds as "watchSeconds",
          least(aggregate.completions, aggregate.plays)::int as "completions"
        from aggregate
      `);
      const rawMetrics = result.rows[0] ?? { plays: 0, uniqueSessions: 0, watchSeconds: 0, completions: 0 };
      // This should be unreachable because modern is one row per eligible
      // session. Retain a last-line invariant so a malformed historic row can
      // never poison the dirty queue with a check-constraint retry loop.
      const metrics = {
        plays: Math.max(0, rawMetrics.plays),
        uniqueSessions: Math.max(0, rawMetrics.uniqueSessions),
        watchSeconds: Math.max(0, rawMetrics.watchSeconds),
        completions: Math.min(Math.max(0, rawMetrics.completions), Math.max(0, rawMetrics.plays)),
      };
      if (metrics.completions !== rawMetrics.completions || metrics.plays !== rawMetrics.plays
          || metrics.watchSeconds !== rawMetrics.watchSeconds || metrics.uniqueSessions !== rawMetrics.uniqueSessions) {
        logger.warn({ organizationId: dirty.organizationId, videoId: dirty.videoId, day: dirty.day },
          "Analytics rollup metrics were clamped after invariant violation");
      }
      await tx.insert(videoAnalyticsRollupsTable).values({
        organizationId: dirty.organizationId, videoId: dirty.videoId, day: dirty.day,
        plays: metrics.plays, uniqueSessions: metrics.uniqueSessions,
        watchTimeSeconds: metrics.watchSeconds, completions: metrics.completions,
        completionRate: metrics.plays ? metrics.completions / metrics.plays : 0,
      }).onConflictDoUpdate({
        target: [videoAnalyticsRollupsTable.organizationId, videoAnalyticsRollupsTable.videoId, videoAnalyticsRollupsTable.day],
        set: {
          plays: metrics.plays, uniqueSessions: metrics.uniqueSessions,
          watchTimeSeconds: metrics.watchSeconds, completions: metrics.completions,
          completionRate: metrics.plays ? metrics.completions / metrics.plays : 0,
        },
      });
      const deleted = await tx.delete(analyticsDirtyDaysTable).where(and(
        eq(analyticsDirtyDaysTable.organizationId, dirty.organizationId),
        eq(analyticsDirtyDaysTable.videoId, dirty.videoId),
        eq(analyticsDirtyDaysTable.day, dirty.day),
        eq(analyticsDirtyDaysTable.version, dirty.version),
      )).returning({ day: analyticsDirtyDaysTable.day });
      return { clean: deleted.length === 1, ...metrics };
    });
  } catch (error) {
    await withWorkerDb("analytics", async (tx) => {
      await tx.update(analyticsDirtyDaysTable).set({
        claimedAt: null,
        availableAt: new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.min(10, dirty.attempts) * 1000)),
        lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
      }).where(and(
        eq(analyticsDirtyDaysTable.organizationId, dirty.organizationId),
        eq(analyticsDirtyDaysTable.videoId, dirty.videoId),
        eq(analyticsDirtyDaysTable.day, dirty.day),
        eq(analyticsDirtyDaysTable.version, dirty.version),
      ));
    });
    throw error;
  }
}

export async function processAnalyticsDirtyDays(limit = 100) {
  let processed = 0;
  while (processed < limit) {
    const dirty = await claimAnalyticsDirtyDay();
    if (!dirty) break;
    await recomputeAnalyticsDay(dirty);
    processed++;
  }
  return { processed };
}

export async function purgeAnalyticsData(now = new Date()) {
  const rawCutoff = new Date(now.getTime() - 90 * 86_400_000);
  return withWorkerDb("analytics", async (tx) => {
    const raw = await tx.execute(sql`
      delete from ${playbackEventsTable} event
      where event.received_at < ${rawCutoff}
        and not exists(select 1 from ${analyticsDirtyDaysTable} dirty
          where dirty.organization_id=event.organization_id and dirty.video_id=event.video_id
            and dirty.day=(event.occurred_at at time zone 'UTC')::date)
        and exists(select 1 from ${videoAnalyticsRollupsTable} rollup
          where rollup.organization_id=event.organization_id and rollup.video_id=event.video_id
            and rollup.day=(event.occurred_at at time zone 'UTC')::date)
    `);
    const windows = await tx.delete(analyticsRateWindowsTable).where(sql`${analyticsRateWindowsTable.expiresAt} < ${now}`).returning();
    const sessions = await tx.delete(analyticsPlaybackSessionsTable).where(sql`
      ${analyticsPlaybackSessionsTable.expiresAt} < ${rawCutoff}
      and not exists(select 1 from ${playbackEventsTable} event where event.organization_id=${analyticsPlaybackSessionsTable.organizationId}
        and event.video_id=${analyticsPlaybackSessionsTable.videoId} and event.session_id=${analyticsPlaybackSessionsTable.clientSessionId})
    `).returning();
    return { rawEvents: raw.rowCount ?? 0, rateWindows: windows.length, sessions: sessions.length };
  });
}