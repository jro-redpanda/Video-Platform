import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  analyticsDirtyDaysTable,
  analyticsPlaybackSessionsTable,
  analyticsRateWindowsTable,
  playbackEventsTable,
  videoEmbedsTable,
  videosTable,
} from "@workspace/db";
import { withOrganizationDb, type TenantTransaction } from "./tenant-db";

const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error("SESSION_SECRET is required");
const signingKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("vid-analytics"), Buffer.from("playback-grant:v1"), 32));
const hashingKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("vid-analytics"), Buffer.from("rate-dimensions:v1"), 32));
const encoder = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const grantLifetimeMs = 30 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventTypes = new Set<PlaybackInput["type"]>(["load", "play", "progress", "pause", "ended", "error"]);
const errorCategories = new Set<NonNullable<PlaybackInput["errorCategory"]>>(["network", "media", "decode", "source", "unknown"]);

type GrantClaims = {
  v: 1;
  organizationId: string;
  videoId: string;
  embedId: string;
  sessionId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  jti: string;
};

export class AnalyticsHttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 409 | 429, public code: string, public retryAfter?: number) {
    super(code);
  }
}

export function issueAnalyticsGrant(input: Omit<GrantClaims, "v" | "jti" | "issuedAt" | "expiresAt">, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims: GrantClaims = { v: 1, ...input, jti: randomUUID(), issuedAt, expiresAt: issuedAt + grantLifetimeMs / 1000 };
  const payload = encoder(claims);
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return { grant: `v1.${payload}.${signature}`, expiresAt: new Date(claims.expiresAt * 1000) };
}

export function verifyAnalyticsGrant(token: string, now = new Date()): GrantClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new AnalyticsHttpError(401, "invalid_analytics_grant");
  const expected = createHmac("sha256", signingKey).update(parts[1]!).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[2]!, "base64url"); } catch { throw new AnalyticsHttpError(401, "invalid_analytics_grant"); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AnalyticsHttpError(401, "invalid_analytics_grant");
  let claims: GrantClaims;
  try { claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as GrantClaims; }
  catch { throw new AnalyticsHttpError(401, "invalid_analytics_grant"); }
  if (claims.v !== 1 || !Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt)
      || claims.expiresAt <= Math.floor(now.getTime() / 1000) || claims.issuedAt > Math.floor(now.getTime() / 1000) + 60) {
    throw new AnalyticsHttpError(401, "expired_or_invalid_analytics_grant");
  }
  for (const value of [claims.organizationId, claims.videoId, claims.embedId, claims.sessionId, claims.jti]) {
    if (typeof value !== "string" || !uuidPattern.test(value)) throw new AnalyticsHttpError(401, "invalid_analytics_grant");
  }
  return claims;
}

export type PlaybackInput = {
  eventId: string; sessionId: string; type: "load" | "play" | "progress" | "pause" | "ended" | "error";
  occurredAt: string | Date; positionSeconds?: number; durationSeconds?: number;
  errorCategory?: "network" | "media" | "decode" | "source" | "unknown";
};
export type AnalyticsLimits = { windowMs: number; ipRequests: number; ipEvents: number; grantRequests: number; grantEvents: number };
export const defaultAnalyticsLimits: AnalyticsLimits = {
  windowMs: 60_000, ipRequests: 120, ipEvents: 1_500, grantRequests: 60, grantEvents: 750,
};
export const defaultGrantLimits = { windowMs: 60_000, requests: 30 };

function hashDimension(value: string) {
  return createHmac("sha256", hashingKey).update(value).digest("hex");
}

export function normalizeClientIp(value: string | undefined) {
  const candidate = (value ?? "unknown").trim().toLowerCase().replace(/^::ffff:/, "");
  return candidate.length <= 64 && /^[0-9a-f:.]+$/.test(candidate) ? candidate : "unknown";
}

/** Public metadata issuance is also persisted/rate-limited without retaining IPs. */
export async function consumeGrantIssueLimit(organizationId: string, videoId: string, ip: string, now = new Date()) {
  const limits = defaultGrantLimits;
  const started = new Date(Math.floor(now.getTime() / limits.windowMs) * limits.windowMs);
  const expires = new Date(started.getTime() + limits.windowMs);
  await withOrganizationDb(organizationId, async (tx) => {
    const [row] = await tx.insert(analyticsRateWindowsTable).values({
      organizationId, dimensionType: "grant_video", dimensionHash: hashDimension(`issue:${videoId}:${normalizeClientIp(ip)}`),
      windowStartedAt: started, expiresAt: expires, requestCount: 1, eventCount: 0,
    }).onConflictDoUpdate({
      target: [analyticsRateWindowsTable.organizationId, analyticsRateWindowsTable.dimensionType, analyticsRateWindowsTable.dimensionHash, analyticsRateWindowsTable.windowStartedAt],
      set: { requestCount: sql`${analyticsRateWindowsTable.requestCount} + 1` },
    }).returning({ requests: analyticsRateWindowsTable.requestCount });
    if (!row || row.requests > limits.requests) throw new AnalyticsHttpError(429, "analytics_grant_rate_limited",
      Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000)));
  });
}

function immutableEqual(existing: typeof playbackEventsTable.$inferSelect, event: PlaybackInput) {
  return existing.sessionId === event.sessionId && existing.eventType === event.type
    && existing.occurredAt.getTime() === new Date(event.occurredAt).getTime()
    && existing.positionSeconds === (event.positionSeconds ?? 0)
    && existing.durationSeconds === (event.durationSeconds ?? null)
    && existing.errorCategory === (event.errorCategory ?? null);
}

async function consumeLimit(tx: TenantTransaction, claims: GrantClaims, type: "ip" | "grant_video", hash: string,
  eventCount: number, maxRequests: number, maxEvents: number, now: Date, windowMs: number) {
  const started = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expires = new Date(started.getTime() + windowMs);
  const [row] = await tx.insert(analyticsRateWindowsTable).values({
    organizationId: claims.organizationId, dimensionType: type, dimensionHash: hash,
    windowStartedAt: started, expiresAt: expires, requestCount: 1, eventCount,
  }).onConflictDoUpdate({
    target: [analyticsRateWindowsTable.organizationId, analyticsRateWindowsTable.dimensionType,
      analyticsRateWindowsTable.dimensionHash, analyticsRateWindowsTable.windowStartedAt],
    set: {
      requestCount: sql`${analyticsRateWindowsTable.requestCount} + 1`,
      eventCount: sql`${analyticsRateWindowsTable.eventCount} + ${eventCount}`,
    },
  }).returning({ requests: analyticsRateWindowsTable.requestCount, events: analyticsRateWindowsTable.eventCount });
  if (!row || row.requests > maxRequests || row.events > maxEvents) {
    throw new AnalyticsHttpError(429, "analytics_rate_limited", Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000)));
  }
}

export async function ingestPlaybackEvents(input: {
  grant: string; events: PlaybackInput[]; ip: string; now?: Date; limits?: AnalyticsLimits;
}) {
  const now = input.now ?? new Date();
  const claims = verifyAnalyticsGrant(input.grant, now);
  const limits = input.limits ?? defaultAnalyticsLimits;
  if (input.events.length < 1 || input.events.length > 50) {
    throw new AnalyticsHttpError(400, "invalid_event_batch_size");
  }
  return withOrganizationDb(claims.organizationId, async (tx) => {
    await tx.delete(analyticsRateWindowsTable).where(sql`${analyticsRateWindowsTable.expiresAt} < ${now}`);
    const [active] = await tx.select({
      id: videosTable.id, organizationId: videosTable.organizationId, visibility: videosTable.visibility,
      status: videosTable.status, embedId: videoEmbedsTable.videoId, generation: videoEmbedsTable.generationVersion,
      generationStatus: videoEmbedsTable.generationStatus,
    }).from(videosTable).innerJoin(videoEmbedsTable, eq(videoEmbedsTable.videoId, videosTable.id))
      .where(and(eq(videosTable.id, claims.videoId), eq(videosTable.organizationId, claims.organizationId))).limit(1);
    if (!active || active.embedId !== claims.embedId || active.generation !== claims.generation
        || active.generationStatus !== "generated" || active.visibility === "private" || active.status !== "ready") {
      throw new AnalyticsHttpError(403, "analytics_grant_not_active");
    }
    const earliest = now.getTime() - 7 * 86_400_000;
    const latest = now.getTime() + 5 * 60_000;
    for (const event of input.events) {
      const occurred = new Date(event.occurredAt).getTime();
      if (!Number.isFinite(occurred) || occurred < earliest || occurred > latest) throw new AnalyticsHttpError(400, "event_timestamp_out_of_range");
      if (!uuidPattern.test(event.eventId) || !uuidPattern.test(event.sessionId)) {
        throw new AnalyticsHttpError(400, "invalid_event_identifier");
      }
      if (!eventTypes.has(event.type)
          || (event.errorCategory !== undefined && !errorCategories.has(event.errorCategory))) {
        throw new AnalyticsHttpError(400, "invalid_event_type");
      }
      if ((event.positionSeconds !== undefined && (!Number.isFinite(event.positionSeconds) || event.positionSeconds < 0 || event.positionSeconds > 86_400))
          || (event.durationSeconds !== undefined && (!Number.isFinite(event.durationSeconds) || event.durationSeconds < 0 || event.durationSeconds > 86_400))) {
        throw new AnalyticsHttpError(400, "invalid_event_timing");
      }
      if ((event.type === "progress" || event.type === "pause" || event.type === "ended") && event.positionSeconds === undefined) {
        throw new AnalyticsHttpError(400, "event_position_required");
      }
      if ((event.type === "progress" || event.type === "ended") && event.durationSeconds === undefined) {
        throw new AnalyticsHttpError(400, "event_duration_required");
      }
      if (event.type === "error" ? !event.errorCategory : event.errorCategory !== undefined) throw new AnalyticsHttpError(400, "invalid_error_category");
      if (event.positionSeconds !== undefined && event.durationSeconds !== undefined && event.positionSeconds > event.durationSeconds + 5) {
        throw new AnalyticsHttpError(400, "event_position_exceeds_duration");
      }
    }
    const sessionIds = [...new Set(input.events.map((event) => event.sessionId))];
    if (sessionIds.length !== 1) throw new AnalyticsHttpError(400, "batch_must_contain_one_session");
    const sessionId = sessionIds[0]!;
    if (sessionId !== claims.sessionId) throw new AnalyticsHttpError(403, "analytics_grant_session_mismatch");
    const grantJtiHash = hashDimension(`grant-jti:${claims.jti}`);
    const [attested] = await tx.select().from(analyticsPlaybackSessionsTable).where(and(
      eq(analyticsPlaybackSessionsTable.organizationId, claims.organizationId),
      eq(analyticsPlaybackSessionsTable.videoId, claims.videoId),
      eq(analyticsPlaybackSessionsTable.clientSessionId, sessionId),
    )).limit(1).for("update");
    if (!attested) {
      const load = [...input.events].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
        .find((event) => event.type === "load");
      if (!load) throw new AnalyticsHttpError(403, "analytics_session_requires_load");
      try {
        await tx.insert(analyticsPlaybackSessionsTable).values({
          organizationId: claims.organizationId, videoId: claims.videoId, embedId: claims.embedId,
          clientSessionId: sessionId, grantJtiHash, firstReceivedAt: now,
          loadOccurredAt: new Date(load.occurredAt), lastReceivedAt: now,
          expiresAt: new Date(claims.expiresAt * 1000),
        });
      } catch (error) {
        // A grant cannot be used to establish a second UUID; neither raw grant
        // data nor its hash is returned/logged.
        if ((error as { code?: string; cause?: { code?: string } }).code === "23505"
          || (error as { cause?: { code?: string } }).cause?.code === "23505") {
          throw new AnalyticsHttpError(409, "analytics_grant_session_collision");
        }
        throw error;
      }
    } else if (attested.embedId !== claims.embedId) {
      throw new AnalyticsHttpError(409, "analytics_grant_session_collision");
    } else if (attested.grantJtiHash !== grantJtiHash) {
      try {
        const rebound = await tx.update(analyticsPlaybackSessionsTable).set({
          grantJtiHash,
          lastReceivedAt: now,
          expiresAt: new Date(claims.expiresAt * 1000),
        }).where(and(
          eq(analyticsPlaybackSessionsTable.organizationId, claims.organizationId),
          eq(analyticsPlaybackSessionsTable.videoId, claims.videoId),
          eq(analyticsPlaybackSessionsTable.clientSessionId, sessionId),
          eq(analyticsPlaybackSessionsTable.grantJtiHash, attested.grantJtiHash),
        )).returning({ sessionId: analyticsPlaybackSessionsTable.clientSessionId });
        if (rebound.length !== 1) throw new AnalyticsHttpError(409, "analytics_grant_session_collision");
      } catch (error) {
        if (error instanceof AnalyticsHttpError) throw error;
        if ((error as { code?: string; cause?: { code?: string } }).code === "23505"
          || (error as { cause?: { code?: string } }).cause?.code === "23505") {
          throw new AnalyticsHttpError(409, "analytics_grant_session_collision");
        }
        throw error;
      }
    } else {
      await tx.update(analyticsPlaybackSessionsTable).set({ lastReceivedAt: now }).where(and(
        eq(analyticsPlaybackSessionsTable.organizationId, claims.organizationId),
        eq(analyticsPlaybackSessionsTable.videoId, claims.videoId),
        eq(analyticsPlaybackSessionsTable.clientSessionId, sessionId),
      ));
    }
    let accepted = 0;
    let duplicates = 0;
    for (const event of input.events) {
      const [inserted] = await tx.insert(playbackEventsTable).values({
        eventId: event.eventId, organizationId: claims.organizationId, videoId: claims.videoId,
        embedId: claims.embedId, sessionId: event.sessionId, eventType: event.type,
        positionSeconds: event.positionSeconds ?? 0, durationSeconds: event.durationSeconds,
        errorCategory: event.errorCategory, occurredAt: new Date(event.occurredAt), receivedAt: now,
      }).onConflictDoNothing({
        target: [playbackEventsTable.organizationId, playbackEventsTable.eventId],
      }).returning({ id: playbackEventsTable.id });
      if (inserted) {
        accepted++;
        const day = new Date(event.occurredAt).toISOString().slice(0, 10);
        await tx.insert(analyticsDirtyDaysTable).values({
          organizationId: claims.organizationId, videoId: claims.videoId, day,
        }).onConflictDoUpdate({
          target: [analyticsDirtyDaysTable.organizationId, analyticsDirtyDaysTable.videoId, analyticsDirtyDaysTable.day],
          set: {
            version: sql`${analyticsDirtyDaysTable.version} + 1`,
            availableAt: now,
            attempts: 0,
            claimedAt: null,
            lastError: null,
          },
        });
      } else {
        const [existing] = await tx.select().from(playbackEventsTable).where(and(
          eq(playbackEventsTable.organizationId, claims.organizationId), eq(playbackEventsTable.eventId, event.eventId),
        )).limit(1);
        if (!existing || !immutableEqual(existing, event)) throw new AnalyticsHttpError(409, "event_id_collision");
        duplicates++;
      }
    }
    // Requests remain bounded, but immutable retries only consume event quota
    // for records newly accepted by this transaction.
    await consumeLimit(tx, claims, "ip", hashDimension(normalizeClientIp(input.ip)), accepted,
      limits.ipRequests, limits.ipEvents, now, limits.windowMs);
    await consumeLimit(tx, claims, "grant_video", hashDimension(`${claims.videoId}:${input.grant}`), accepted,
      limits.grantRequests, limits.grantEvents, now, limits.windowMs);
    return { accepted, duplicates };
  });
}