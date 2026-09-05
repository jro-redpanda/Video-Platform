import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import {
  analyticsDirtyDaysTable,
  analyticsRateWindowsTable,
  db,
  organizationsTable,
  plansTable,
  playbackEventsTable,
  videoAnalyticsRollupsTable,
  videoEmbedsTable,
  videosTable,
} from "@workspace/db";
import {
  AnalyticsHttpError,
  ingestPlaybackEvents,
  issueAnalyticsGrant,
  verifyAnalyticsGrant,
} from "./lib/playback-analytics";
import { purgeAnalyticsData, recomputeAnalyticsDay } from "./lib/analytics-rollup";
import { withOrganizationDb } from "./lib/tenant-db";
import { createApp } from "./app";

const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const videoId = randomUUID();
const foreignVideoId = randomUUID();
const sessionId = randomUUID();
const now = new Date("2025-08-20T12:00:00.000Z");
const day = "2025-08-20";
const expectAnalyticsError = async (status: number, operation: () => unknown | Promise<unknown>) => {
  await assert.rejects(Promise.resolve().then(operation),
    (error: unknown) => error instanceof AnalyticsHttpError && error.status === status);
};
let server: Server | undefined;
const postJson = async (path: string, body: unknown) => {
  assert(server);
  const payload = Buffer.from(JSON.stringify(body));
  const address = server.address() as AddressInfo;
  return new Promise<{ status: number; body: unknown; retryAfter?: string }>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) : undefined,
          retryAfter: Array.isArray(res.headers["retry-after"]) ? res.headers["retry-after"][0] : res.headers["retry-after"],
        });
      });
    });
    req.once("error", reject);
    req.end(payload);
  });
};

try {
  await db.insert(plansTable).values({ id: planId, code: `analytics-${planId}`, name: "Analytics smoke", storageLimitGb: 1 });
  await db.insert(organizationsTable).values([
    { id: organizationId, name: "Analytics A", slug: `analytics-a-${organizationId}`, planId, status: "active" },
    { id: foreignOrganizationId, name: "Analytics B", slug: `analytics-b-${foreignOrganizationId}`, planId, status: "active" },
  ]);
  await db.insert(videosTable).values([
    { id: videoId, organizationId, title: "Analytics", status: "ready", visibility: "unlisted", durationSeconds: 100 },
    { id: foreignVideoId, organizationId: foreignOrganizationId, title: "Foreign", status: "ready", visibility: "public", durationSeconds: 100 },
  ]);
  await db.insert(videoEmbedsTable).values([
    { videoId, embedPath: `/v/${videoId}`, generationVersion: 3, generationStatus: "generated", generatedMetadata: { title: "Analytics", description: "", durationSeconds: 100 } },
    { videoId: foreignVideoId, embedPath: `/v/${foreignVideoId}`, generationVersion: 1, generationStatus: "generated", generatedMetadata: { title: "Foreign", description: "", durationSeconds: 100 } },
  ]);

  server = await new Promise<Server>((resolve) => {
    const listener = createApp({ initialReady: true }).listen(0, "127.0.0.1", () => resolve(listener));
  });
  const routeSession = randomUUID();
  const routeGrant = await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: routeSession });
  assert.equal(routeGrant.status, 201);
  assert.equal(verifyAnalyticsGrant((routeGrant.body as { grant: string }).grant).sessionId, routeSession);
  assert.equal((await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: "invalid" })).status, 400);
  assert.equal((await postJson(`/api/public/videos/${randomUUID()}/analytics-grant`, { sessionId: randomUUID() })).status, 404);
  await db.update(videosTable).set({ visibility: "private" }).where(eq(videosTable.id, videoId));
  assert.equal((await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: randomUUID() })).status, 404);
  await db.update(videosTable).set({ visibility: "unlisted" }).where(eq(videosTable.id, videoId));
  await db.update(videoEmbedsTable).set({ generationStatus: "disabled" }).where(eq(videoEmbedsTable.videoId, videoId));
  assert.equal((await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: randomUUID() })).status, 404);
  await db.update(videoEmbedsTable).set({ generationStatus: "generated" }).where(eq(videoEmbedsTable.videoId, videoId));
  for (let index = 1; index < 30; index++) {
    assert.equal((await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: randomUUID() })).status, 201);
  }
  const limitedGrant = await postJson(`/api/public/videos/${videoId}/analytics-grant`, { sessionId: randomUUID() });
  assert.equal(limitedGrant.status, 429);
  assert(Number(limitedGrant.retryAfter) >= 1);

  const issued = issueAnalyticsGrant({ organizationId, videoId, embedId: videoId, generation: 3, sessionId }, now);
  assert.equal(verifyAnalyticsGrant(issued.grant, now).videoId, videoId);
  await expectAnalyticsError(401, () => verifyAnalyticsGrant(`${issued.grant.slice(0, -1)}x`, now));
  const expired = issueAnalyticsGrant({
    organizationId, videoId, embedId: videoId, generation: 3, sessionId,
  }, new Date(now.getTime() - 31 * 60_000));
  await expectAnalyticsError(401, () => verifyAnalyticsGrant(expired.grant, now));
  const wrong = issueAnalyticsGrant({
    organizationId, videoId: foreignVideoId, embedId: foreignVideoId, generation: 1, sessionId,
  }, now);
  await expectAnalyticsError(403, () => ingestPlaybackEvents({ grant: wrong.grant, events: [{
    eventId: randomUUID(), sessionId, type: "play", occurredAt: now, positionSeconds: 0,
  }], ip: "127.0.0.1", now }));
  await expectAnalyticsError(400, () => ingestPlaybackEvents({ grant: issued.grant, events: [], ip: "127.0.0.1", now }));
  await expectAnalyticsError(400, () => ingestPlaybackEvents({
    grant: issued.grant,
    events: Array.from({ length: 51 }, () => ({
      eventId: randomUUID(), sessionId, type: "load" as const, occurredAt: now,
    })),
    ip: "127.0.0.1",
    now,
  }));

  const events = [
    { eventId: randomUUID(), sessionId, type: "ended" as const, occurredAt: new Date(now.getTime() + 90_000), positionSeconds: 90, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId, type: "play" as const, occurredAt: now, positionSeconds: 0, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId, type: "progress" as const, occurredAt: new Date(now.getTime() + 20_000), positionSeconds: 20, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId, type: "load" as const, occurredAt: new Date(now.getTime() - 1_000) },
  ];
  const invalidSession = (_offset: number) => randomUUID();
  const endedOnly = invalidSession(1), playOnly = invalidSession(2), prePlay = invalidSession(3);
  const durationMutation = invalidSession(4), jump = invalidSession(5), legacy = invalidSession(6);
  const adversarial = [
    // Repeated ended remains one completion for the valid reordered lifecycle.
    { eventId: randomUUID(), sessionId, type: "ended" as const, occurredAt: new Date(now.getTime() + 91_000), positionSeconds: 91, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId: endedOnly, type: "ended" as const, occurredAt: now, positionSeconds: 100, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId: playOnly, type: "play" as const, occurredAt: now, positionSeconds: 0 },
    { eventId: randomUUID(), sessionId: prePlay, type: "progress" as const, occurredAt: now, positionSeconds: 10, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId: prePlay, type: "load" as const, occurredAt: new Date(now.getTime() + 1_000) },
    { eventId: randomUUID(), sessionId: prePlay, type: "play" as const, occurredAt: new Date(now.getTime() + 2_000), positionSeconds: 0 },
    { eventId: randomUUID(), sessionId: durationMutation, type: "load" as const, occurredAt: now },
    { eventId: randomUUID(), sessionId: durationMutation, type: "play" as const, occurredAt: new Date(now.getTime() + 1_000), positionSeconds: 0 },
    { eventId: randomUUID(), sessionId: durationMutation, type: "progress" as const, occurredAt: new Date(now.getTime() + 2_000), positionSeconds: 10, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId: durationMutation, type: "ended" as const, occurredAt: new Date(now.getTime() + 3_000), positionSeconds: 90, durationSeconds: 130 },
    { eventId: randomUUID(), sessionId: jump, type: "load" as const, occurredAt: now },
    { eventId: randomUUID(), sessionId: jump, type: "play" as const, occurredAt: new Date(now.getTime() + 1_000), positionSeconds: 0 },
    { eventId: randomUUID(), sessionId: jump, type: "progress" as const, occurredAt: new Date(now.getTime() + 2_000), positionSeconds: 100, durationSeconds: 100 },
    { eventId: randomUUID(), sessionId: jump, type: "ended" as const, occurredAt: new Date(now.getTime() + 3_000), positionSeconds: 100, durationSeconds: 100 },
    // A legacy load+ended must not be a completion beside a credible modern play.
    { eventId: randomUUID(), sessionId: legacy, type: "load" as const, occurredAt: now },
    { eventId: randomUUID(), sessionId: legacy, type: "ended" as const, occurredAt: new Date(now.getTime() + 1_000), positionSeconds: 100, durationSeconds: 100 },
  ];
  const loadOnly = events.filter((event) => event.type === "load");
  const laterEvents = events.filter((event) => event.type !== "load");
  assert.deepEqual(await ingestPlaybackEvents({ grant: issued.grant, events: loadOnly, ip: "127.0.0.1", now }), { accepted: 1, duplicates: 0 });
  await expectAnalyticsError(403, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId: randomUUID(), type: "load", occurredAt: now,
  }], ip: "127.0.0.1", now }));
  assert.deepEqual(await ingestPlaybackEvents({ grant: issued.grant, events: laterEvents, ip: "127.0.0.1", now: new Date(now.getTime() + 2 * 60_000) }), { accepted: 3, duplicates: 0 });
  const continuation = issueAnalyticsGrant({ organizationId, videoId, embedId: videoId, generation: 3, sessionId },
    new Date(now.getTime() + 3 * 60_000));
  const continuationEvent = {
    eventId: randomUUID(), sessionId, type: "pause" as const,
    occurredAt: new Date(now.getTime() + 92_000), positionSeconds: 91, durationSeconds: 100,
  };
  assert.deepEqual(await ingestPlaybackEvents({
    grant: continuation.grant,
    events: [continuationEvent],
    ip: "127.0.0.1",
    now: new Date(now.getTime() + 3 * 60_000),
  }), { accepted: 1, duplicates: 0 });
  await expectAnalyticsError(403, () => ingestPlaybackEvents({
    grant: issued.grant,
    events: [{ eventId: randomUUID(), sessionId: randomUUID(), type: "load", occurredAt: now }],
    ip: "127.0.0.1",
    now: new Date(now.getTime() + 3 * 60_000),
  }));
  // One grant is deliberately bound to one client UUID. Adversarial sessions
  // use independent grants so raw data is retained while rollup rejects them.
  for (const id of [endedOnly, playOnly, prePlay, durationMutation, jump, legacy]) {
    const grant = issueAnalyticsGrant({
      organizationId, videoId, embedId: videoId, generation: 3, sessionId: id,
    }, now).grant;
    const input = () => ingestPlaybackEvents({ grant, events: adversarial.filter((event) => event.sessionId === id),
      ip: "127.0.0.2", now: new Date(now.getTime() + 2 * 60_000) });
    if (id === endedOnly || id === playOnly) await expectAnalyticsError(403, input);
    else await input();
  }
  assert.deepEqual(await ingestPlaybackEvents({
    grant: continuation.grant,
    events: [...events, continuationEvent],
    ip: "127.0.0.1",
    now: new Date(now.getTime() + 3 * 60_000),
  }), { accepted: 0, duplicates: 5 });
  await expectAnalyticsError(409, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    ...events[0]!, positionSeconds: 80,
  }], ip: "127.0.0.1", now: new Date(now.getTime() + 2 * 60_000) }));

  // Sufficient receipt dwell does not turn a low-position ended event into a
  // completion; terminal and progress use the same credible 90% threshold.
  const lowDay = "2025-08-19";
  const lowSession = randomUUID();
  const lowGrant = issueAnalyticsGrant({
    organizationId, videoId, embedId: videoId, generation: 3, sessionId: lowSession,
  }, now).grant;
  await ingestPlaybackEvents({ grant: lowGrant, events: [{
    eventId: randomUUID(), sessionId: lowSession, type: "load", occurredAt: `${lowDay}T12:00:00.000Z`,
  }], ip: "127.0.0.4", now });
  await ingestPlaybackEvents({ grant: lowGrant, events: [
    { eventId: randomUUID(), sessionId: lowSession, type: "play", occurredAt: `${lowDay}T12:00:01.000Z`, positionSeconds: 0 },
    { eventId: randomUUID(), sessionId: lowSession, type: "ended", occurredAt: `${lowDay}T12:01:31.000Z`, positionSeconds: 1, durationSeconds: 100 },
  ], ip: "127.0.0.4", now: new Date(now.getTime() + 2 * 60_000) });
  const [lowDirty] = await db.select().from(analyticsDirtyDaysTable).where(and(
    eq(analyticsDirtyDaysTable.organizationId, organizationId), eq(analyticsDirtyDaysTable.day, lowDay),
  ));
  assert(lowDirty);
  const lowResult = await recomputeAnalyticsDay({
    organizationId, videoId, day: lowDay, version: lowDirty.version, attempts: lowDirty.attempts,
  });
  assert.deepEqual({ plays: lowResult.plays, completions: lowResult.completions }, { plays: 1, completions: 0 });

  const loadOnlyDay = "2025-08-18";
  const loadOnlySession = randomUUID();
  const loadOnlyGrant = issueAnalyticsGrant({
    organizationId, videoId, embedId: videoId, generation: 3, sessionId: loadOnlySession,
  }, now).grant;
  await ingestPlaybackEvents({
    grant: loadOnlyGrant,
    events: [{
      eventId: randomUUID(), sessionId: loadOnlySession, type: "load",
      occurredAt: `${loadOnlyDay}T12:00:00.000Z`,
    }],
    ip: "127.0.0.5",
    now,
  });
  const [loadOnlyDirty] = await db.select().from(analyticsDirtyDaysTable).where(and(
    eq(analyticsDirtyDaysTable.organizationId, organizationId),
    eq(analyticsDirtyDaysTable.day, loadOnlyDay),
  ));
  assert(loadOnlyDirty);
  const loadOnlyResult = await recomputeAnalyticsDay({
    organizationId, videoId, day: loadOnlyDay, version: loadOnlyDirty.version, attempts: loadOnlyDirty.attempts,
  });
  assert.deepEqual({ plays: loadOnlyResult.plays, completions: loadOnlyResult.completions }, { plays: 0, completions: 0 });

  const [dirty] = await db.select().from(analyticsDirtyDaysTable).where(eq(analyticsDirtyDaysTable.organizationId, organizationId));
  assert(dirty);
  const result = await recomputeAnalyticsDay({
    organizationId, videoId, day, version: dirty.version, attempts: dirty.attempts,
  });
  assert.deepEqual({ plays: result.plays, sessions: result.uniqueSessions, watch: result.watchSeconds, completions: result.completions },
    { plays: 1, sessions: 1, watch: 91, completions: 1 });
  assert.equal(result.clean, true);
  await recomputeAnalyticsDay({ organizationId, videoId, day, version: 999, attempts: 1 });
  const [rollup] = await db.select().from(videoAnalyticsRollupsTable).where(and(
    eq(videoAnalyticsRollupsTable.videoId, videoId), eq(videoAnalyticsRollupsTable.day, day),
  ));
  assert.equal(rollup?.completionRate, 1);

  await db.update(videosTable).set({ visibility: "private" }).where(eq(videosTable.id, videoId));
  await expectAnalyticsError(403, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId, type: "load", occurredAt: now,
  }], ip: "127.0.0.1", now }));
  await db.update(videosTable).set({ visibility: "unlisted" }).where(eq(videosTable.id, videoId));
  await db.update(videoEmbedsTable).set({ generationStatus: "disabled" }).where(eq(videoEmbedsTable.videoId, videoId));
  await expectAnalyticsError(403, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId, type: "load", occurredAt: now,
  }], ip: "127.0.0.1", now }));
  await db.update(videoEmbedsTable).set({ generationStatus: "generated" }).where(eq(videoEmbedsTable.videoId, videoId));

  const limited = { windowMs: 60_000, ipRequests: 1, ipEvents: 50, grantRequests: 10, grantEvents: 50 };
  const rateSession = sessionId;
  await ingestPlaybackEvents({ grant: issued.grant, events: [{ eventId: randomUUID(), sessionId: rateSession, type: "load", occurredAt: now }],
    ip: "10.0.0.1", now, limits: limited });
  await expectAnalyticsError(429, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId: rateSession, type: "load", occurredAt: now,
  }], ip: "10.0.0.1", now, limits: limited }));
  const storedDimensions = await db.select().from(analyticsRateWindowsTable).where(eq(analyticsRateWindowsTable.organizationId, organizationId));
  assert(storedDimensions.every((row) => row.dimensionHash.length === 64 && !row.dimensionHash.includes("10.0.0.1")));
  const grantLimited = { windowMs: 60_000, ipRequests: 10, ipEvents: 50, grantRequests: 1, grantEvents: 50 };
  const grantLimitTime = new Date(now.getTime() + 60_000);
  await ingestPlaybackEvents({ grant: issued.grant, events: [{ eventId: randomUUID(), sessionId: rateSession, type: "load", occurredAt: now }],
    ip: "10.0.0.2", now: grantLimitTime, limits: grantLimited });
  await expectAnalyticsError(429, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId: rateSession, type: "load", occurredAt: now,
  }], ip: "10.0.0.3", now: grantLimitTime, limits: grantLimited }));

  // Exact retries are bounded as requests but do not consume event quota again.
  const retrySession = randomUUID();
  const retryGrant = issueAnalyticsGrant({
    organizationId, videoId, embedId: videoId, generation: 3, sessionId: retrySession,
  }, now).grant;
  const retryEvent = { eventId: randomUUID(), sessionId: retrySession, type: "load" as const, occurredAt: now };
  const retryLimits = { windowMs: 60_000, ipRequests: 3, ipEvents: 1, grantRequests: 3, grantEvents: 1 };
  assert.deepEqual(await ingestPlaybackEvents({
    grant: retryGrant, events: [retryEvent], ip: "10.0.0.9", now, limits: retryLimits,
  }), { accepted: 1, duplicates: 0 });
  assert.deepEqual(await ingestPlaybackEvents({
    grant: retryGrant, events: [retryEvent], ip: "10.0.0.9", now, limits: retryLimits,
  }), { accepted: 0, duplicates: 1 });

  const isolated = await withOrganizationDb(foreignOrganizationId, async (tx) => tx.select({ count: sql<number>`count(*)::int` })
    .from(playbackEventsTable).where(eq(playbackEventsTable.organizationId, organizationId)));
  assert.equal(isolated[0]?.count, 0);
  await db.update(playbackEventsTable).set({ receivedAt: new Date(now.getTime() - 91 * 86_400_000) })
    .where(eq(playbackEventsTable.videoId, videoId));
  await purgeAnalyticsData(new Date(now.getTime() + 2 * 60_000));
  const protectedRows = await db.select({ count: sql<number>`count(*)::int` }).from(playbackEventsTable).where(eq(playbackEventsTable.videoId, videoId));
  assert((protectedRows[0]?.count ?? 0) > 0);
  await db.delete(analyticsDirtyDaysTable).where(and(eq(analyticsDirtyDaysTable.organizationId, organizationId), eq(analyticsDirtyDaysTable.day, day)));
  await purgeAnalyticsData(new Date(now.getTime() + 2 * 60_000));
  const remaining = await db.select({ count: sql<number>`count(*)::int` }).from(playbackEventsTable).where(eq(playbackEventsTable.videoId, videoId));
  assert.equal(remaining[0]?.count, 0);
  await db.delete(videosTable).where(eq(videosTable.id, videoId));
  await expectAnalyticsError(403, () => ingestPlaybackEvents({ grant: issued.grant, events: [{
    eventId: randomUUID(), sessionId: randomUUID(), type: "load", occurredAt: now,
  }], ip: "127.0.0.1", now }));
  console.log("analytics smoke passed");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  await db.delete(organizationsTable).where(sql`${organizationsTable.id} in (${organizationId},${foreignOrganizationId})`);
  await db.delete(plansTable).where(eq(plansTable.id, planId));
}