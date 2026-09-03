import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.NODE_ENV !== "test") throw new Error("Step 11 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  db,
  pool,
  embedGenerationOutboxTable,
  groupPermissionsTable,
  membershipsTable,
  organizationCustomizationTable,
  organizationsTable,
  permissionGroupsTable,
  permissionsTable,
  plansTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videoEmbedsTable,
  videosTable,
  webhookEventsTable,
  usersTable,
} = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { default: app } = await import("./app");
const { generateVideoEmbed, serializeEmbed } = await import("./lib/video-embeds");
const { reconcileEmbedGenerationOutbox } = await import("./lib/jobs");
const { videoProviders } = await import("./lib/provider-registry");
const { Step7SmokeVideoProvider } = await import("@workspace/providers/test-only");

const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const accountId = randomUUID();
const spaceId = randomUUID();
const groupId = randomUUID();
const readyVideoId = randomUUID();
const privateVideoId = randomUUID();
const foreignVideoId = randomUUID();
const eventId = randomUUID();
const outboxId = randomUUID();
const siblingEventId = randomUUID();
const siblingOutboxId = randomUUID();
const exhaustedEventId = randomUUID();
const exhaustedOutboxId = randomUUID();
const missingEventId = randomUUID();
const missingOutboxId = randomUUID();
const providerSpaceId = `private-space-${marker}`;
const providerAssetId = `private-asset-${marker}`;
const credential = `private-credential-${marker}`;

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId, code: `step11-${marker}`, name: "Step 11 smoke", storageLimitGb: 1,
  });
  await tx.insert(organizationsTable).values({
    id: organizationId, name: "Step 11 smoke", slug: `step11-${marker}`, status: "active", planId,
  });
  await tx.insert(organizationsTable).values({
    id: foreignOrganizationId, name: "Step 11 foreign", slug: `step11-foreign-${marker}`, status: "active", planId,
  });
  await tx.insert(organizationCustomizationTable).values({
    organizationId,
    playerAccent: "#123456",
    playerControlForeground: "#FFFFFF",
    playerControlBackground: "#111111",
    posterTreatment: "contain",
  });
  await tx.insert(permissionGroupsTable).values({
    id: groupId, organizationId, name: "Step 11 readers", description: "Smoke readers",
  });
  await tx.insert(permissionsTable).values([
    { key: "videos.read", description: "Read videos" },
    { key: "videos.update", description: "Update videos" },
  ]).onConflictDoNothing();
  await tx.insert(groupPermissionsTable).values([
    { groupId, permissionKey: "videos.read" },
    { groupId, permissionKey: "videos.update" },
  ]);
  await tx.insert(providerAccountsTable).values({
    id: accountId,
    providerKey: "step7-smoke",
    label: `step11-${marker}`,
    encryptedCredentials: credential,
    maxZones: 1,
  });
  await tx.insert(providerTenantSpacesTable).values({
    id: spaceId,
    organizationId,
    providerAccountId: accountId,
    providerSpaceId,
    idempotencyKey: `step11-${marker}`,
    state: "created",
  });
  await tx.insert(videosTable).values([
    {
      id: readyVideoId,
      organizationId,
      title: "Portable demo",
      description: "Provider-neutral playback",
      status: "ready",
      visibility: "public",
      durationSeconds: 125,
      providerAccountId: accountId,
      providerTenantSpaceId: providerSpaceId,
      providerAssetId,
    },
    {
      id: privateVideoId,
      organizationId,
      title: "Private demo",
      status: "ready",
      visibility: "private",
      providerAccountId: accountId,
      providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-${providerAssetId}`,
    },
    { id: foreignVideoId, organizationId: foreignOrganizationId, title: "Foreign private", status: "ready", visibility: "private" },
  ]);
  await tx.insert(webhookEventsTable).values({
    id: eventId,
    providerKey: "step7-smoke",
    receiptDigest: marker,
    providerEventId: marker,
    verificationState: "verified",
    processingState: "processed",
    signatureValid: true,
    organizationId,
    ownedVideoId: readyVideoId,
  });
  await tx.insert(embedGenerationOutboxTable).values({
    id: outboxId,
    webhookEventId: eventId,
    videoId: readyVideoId,
    state: "dispatched",
  });
  await tx.insert(webhookEventsTable).values([
    {
      id: siblingEventId, providerKey: "step7-smoke", receiptDigest: `${marker}-sibling`,
      providerEventId: `${marker}-sibling`, verificationState: "verified", processingState: "processed",
      signatureValid: true, organizationId, ownedVideoId: readyVideoId,
    },
    {
      id: exhaustedEventId, providerKey: "step7-smoke", receiptDigest: `${marker}-exhausted`,
      providerEventId: `${marker}-exhausted`, verificationState: "verified", processingState: "processed",
      signatureValid: true, organizationId, ownedVideoId: readyVideoId,
    },
    {
      id: missingEventId, providerKey: "step7-smoke", receiptDigest: `${marker}-missing`,
      providerEventId: `${marker}-missing`, verificationState: "verified", processingState: "processed",
      signatureValid: true, organizationId, ownedVideoId: readyVideoId,
    },
  ]);
  await tx.insert(embedGenerationOutboxTable).values([
    { id: siblingOutboxId, webhookEventId: siblingEventId, videoId: readyVideoId, state: "dispatched" },
    {
      id: exhaustedOutboxId, webhookEventId: exhaustedEventId, videoId: readyVideoId, state: "dispatched",
      dispatchedAt: new Date(Date.now() - 10 * 60_000),
    },
    {
      id: missingOutboxId, webhookEventId: missingEventId, videoId: readyVideoId, state: "dispatched",
      dispatchedAt: new Date(Date.now() - 24 * 60 * 60_000),
    },
  ]);
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

try {
  const email = `step11-${marker}@example.test`;
  const signUp = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Step 11 Smoke", email, password: `Step11-${marker}!` }),
  });
  assert.equal(signUp.status, 200);
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert(user);
  await db.insert(membershipsTable).values({
    organizationId, userId: user.id, groupId, status: "active",
  });

  await generateVideoEmbed(readyVideoId, outboxId);
  await generateVideoEmbed(readyVideoId, outboxId);
  const embeds = await db.select().from(videoEmbedsTable).where(eq(videoEmbedsTable.videoId, readyVideoId));
  assert.equal(embeds.length, 1, "worker replay must upsert one durable record");
  const [outbox] = await db.select().from(embedGenerationOutboxTable)
    .where(eq(embedGenerationOutboxTable.id, outboxId));
  assert.equal(outbox?.state, "completed");
  assert(outbox?.completedAt);
  const [sibling] = await db.select().from(embedGenerationOutboxTable)
    .where(eq(embedGenerationOutboxTable.id, siblingOutboxId));
  assert.equal(sibling?.state, "dispatched", "a job must not complete a sibling outbox row");
  await generateVideoEmbed(readyVideoId, siblingOutboxId);

  const reconciliation = await reconcileEmbedGenerationOutbox({
    findJobs: async (_queue: string, options: { id?: string }) => (
      options.id === exhaustedOutboxId ? [{ state: "failed" }] : []
    ),
  } as never);
  assert.equal(reconciliation.recovered, 1, "an exhausted retained job is safe DB-only recovery");
  assert.equal(reconciliation.quarantined, 1, "a missing job after retention is quarantined");
  const reconciledRows = await db.select({
    id: embedGenerationOutboxTable.id, state: embedGenerationOutboxTable.state,
  }).from(embedGenerationOutboxTable).where(and(
    eq(embedGenerationOutboxTable.videoId, readyVideoId),
  ));
  assert.equal(reconciledRows.find((row) => row.id === exhaustedOutboxId)?.state, "completed");
  assert.equal(reconciledRows.find((row) => row.id === missingOutboxId)?.state, "reconciliation_required");

  const owned = serializeEmbed(embeds[0]!, root);
  assert.equal(owned.embedPath, `/v/${readyVideoId}`);
  assert.equal(owned.embedUrl, `${root}/v/${readyVideoId}`);
  assert.match(owned.embedCode, /position:relative/);
  assert.match(owned.embedCode, /padding-top:56\.25%/);
  assert.match(owned.embedCode, /loading="lazy"/);
  assert.match(owned.embedCode, /allowfullscreen/);
  assert.match(owned.embedCode, /picture-in-picture/);
  assert.equal(owned.videoObject["@type"], "VideoObject");
  assert.equal(owned.videoObject.duration, "PT125S");

  const response = await fetch(`${root}/api/public/videos/${readyVideoId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const publicText = await response.text();
  const publicVideo = JSON.parse(publicText) as Record<string, unknown>;
  assert.equal(publicVideo.sourceType, "hls");
  assert.equal(typeof publicVideo.sourceUrl, "string");
  assert(new Date(String(publicVideo.sourceExpiresAt)).getTime() > Date.now());
  assert.equal(publicText.includes(providerAssetId), false);
  assert.equal(publicText.includes(providerSpaceId), false);
  assert.equal(publicText.includes(accountId), false);
  assert.equal(publicText.includes(credential), false);
  assert.equal(publicText.includes("playback.test.invalid"), false);

  const sourceResponse = await fetch(`${root}${String(publicVideo.sourceUrl)}`, { redirect: "manual" });
  assert.equal(sourceResponse.status, 307);
  assert.equal(sourceResponse.headers.get("cache-control"), "private, no-store");
  assert.match(sourceResponse.headers.get("location") ?? "", /^https:\/\/playback\.test\.invalid\//);

  await db.update(videosTable).set({
    durationSeconds: 130,
  }).where(eq(videosTable.id, readyVideoId));
  const generatedClient = await readFile(new URL("../../../lib/api-client-react/src/generated/api.ts", import.meta.url), "utf8");
  assert.match(
    generatedClient,
    /export const getUpdateVideoUrl = \(videoId: string,\) => \{[\s\S]{0,200}return `\/api\/videos\/\$\{videoId\}`/,
    "generated getUpdateVideoUrl must target the owned video route",
  );
  const patchResponse = await fetch(`${root}/api/videos/${readyVideoId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Renamed portable demo", description: "Current embed metadata", visibility: "unlisted",
    }),
  });
  assert.equal(patchResponse.status, 200);
  const authenticatedResponse = await fetch(`${root}/api/videos/${readyVideoId}`, {
    headers: { cookie },
  });
  assert.equal(authenticatedResponse.status, 200);
  const authenticatedText = await authenticatedResponse.text();
  const authenticatedVideo = JSON.parse(authenticatedText) as Record<string, unknown>;
  assert.equal(authenticatedVideo.embedUrl, `${root}/v/${readyVideoId}`);
  assert.equal(typeof authenticatedVideo.embedCode, "string");
  assert.equal((authenticatedVideo.videoObject as Record<string, unknown>)["@type"], "VideoObject");
  assert.equal((authenticatedVideo.videoObject as Record<string, unknown>).name, "Renamed portable demo");
  assert.equal((authenticatedVideo.videoObject as Record<string, unknown>).duration, "PT130S");
  for (const secretValue of [providerAssetId, providerSpaceId, accountId, credential, "playback.test.invalid"]) {
    assert.equal(authenticatedText.includes(secretValue), false);
  }

  const privatePlayback = await fetch(`${root}/api/videos/${privateVideoId}/playback`, { headers: { cookie } });
  assert.equal(privatePlayback.status, 200);
  assert.equal(privatePlayback.headers.get("cache-control"), "private, no-store");
  const privatePlaybackText = await privatePlayback.text();
  const privatePlaybackJson = JSON.parse(privatePlaybackText) as Record<string, unknown>;
  assert.equal(privatePlaybackJson.sourceUrl, `/api/videos/${privateVideoId}/playback/source`);
  for (const secretValue of [providerAssetId, providerSpaceId, accountId, credential, "playback.test.invalid"]) {
    assert.equal(privatePlaybackText.includes(secretValue), false);
  }
  const privateSource = await fetch(`${root}${String(privatePlaybackJson.sourceUrl)}`, {
    headers: { cookie }, redirect: "manual",
  });
  assert.equal(privateSource.status, 307);
  assert.equal(privateSource.headers.get("cache-control"), "private, no-store");

  // The test adapter normally produces the trusted hostname above. Its
  // test-only override verifies both public and authenticated routes reject a
  // syntactically valid, but provider-untrusted, redirect target.
  const testProvider = videoProviders.resolve("step7-smoke");
  assert.ok(testProvider instanceof Step7SmokeVideoProvider);
  testProvider.playbackUrlOverride = "https://playback.test.invalid.attacker.invalid/master.m3u8";
  try {
    for (const request of [
      fetch(`${root}/api/public/videos/${readyVideoId}`),
      fetch(`${root}/api/public/videos/${readyVideoId}/source`, { redirect: "manual" }),
      fetch(`${root}/api/videos/${privateVideoId}/playback`, { headers: { cookie } }),
      fetch(`${root}/api/videos/${privateVideoId}/playback/source`, { headers: { cookie }, redirect: "manual" }),
    ]) {
      assert.equal((await request).status, 503);
    }
  } finally {
    testProvider.playbackUrlOverride = undefined;
  }

  const crossTenantPlayback = await fetch(`${root}/api/videos/${foreignVideoId}/playback`, { headers: { cookie } });
  assert.equal(crossTenantPlayback.status, 404);
  const crossTenantSource = await fetch(`${root}/api/videos/${foreignVideoId}/playback/source`, {
    headers: { cookie }, redirect: "manual",
  });
  assert.equal(crossTenantSource.status, 404);

  const privateResponse = await fetch(`${root}/api/public/videos/${privateVideoId}`);
  assert.equal(privateResponse.status, 404);

  const copiedOutput = JSON.stringify(owned);
  assert.equal(copiedOutput.includes("playback.test.invalid"), false);
  assert.equal(copiedOutput.includes(providerAssetId), false);
  assert.equal(copiedOutput.includes(providerSpaceId), false);
  assert.equal(copiedOutput.includes(accountId), false);
  assert.equal(copiedOutput.includes(credential), false);
  process.stdout.write("Step 11 embed smoke passed\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(webhookEventsTable).where(eq(webhookEventsTable.id, eventId));
  await db.delete(videosTable).where(and(eq(videosTable.organizationId, organizationId)));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, spaceId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  await db.delete(usersTable).where(eq(usersTable.email, `step11-${marker}@example.test`));
  await pool.end();
}