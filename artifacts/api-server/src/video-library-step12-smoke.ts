import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "test") throw new Error("Step 12 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  db, pool, embedGenerationOutboxTable, groupPermissionsTable, membershipsTable,
  organizationCustomizationTable, organizationsTable, permissionGroupsTable, permissionsTable,
  plansTable, providerAccountsTable, providerTenantSpacesTable, videoAnalyticsRollupsTable,
  videoEmbedsTable, videoLibrarySnapshotsTable, videosTable, webhookEventsTable, usersTable,
} = await import("@workspace/db");
const { and, eq, sql } = await import("drizzle-orm");
const { default: app } = await import("./app");
const { videoProviders } = await import("./lib/provider-registry");
const { registerStep7SmokeProvider } = await import("./lib/test-only-provider-registry");
const { reconcileSystemVideoDeletePermission } = await import("./lib/bootstrap");
registerStep7SmokeProvider();

const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const groupId = randomUUID();
const editorGroupId = randomUUID();
const readOnlyGroupId = randomUUID();
const accountId = randomUUID();
const spaceRowId = randomUUID();
const providerSpaceId = `private-step12-space-${marker}`;
const credential = `private-step12-credential-${marker}`;
const localDeleteId = randomUUID();
const providerDeleteId = randomUUID();
const ambiguousDeleteId = randomUUID();
const foreignVideoId = randomUUID();
const webhookId = randomUUID();
const outboxId = randomUUID();

const libraryVideos = Array.from({ length: 30 }, (_, index) => ({
  id: randomUUID(),
  organizationId,
  title: index === 4 ? "Needle title" : `Library video ${String(index).padStart(2, "0")}`,
  description: index === 7 ? "The searchable haystack needle is in this description" : `Description ${index}`,
  status: (["created", "uploading", "processing", "ready", "error"] as const)[index % 5],
  visibility: (["private", "unlisted", "public"] as const)[index % 3],
  createdAt: new Date(Date.now() - (31 - index) * 24 * 60 * 60 * 1000),
}));

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId, code: `step12-${marker}`, name: "Step 12 smoke", storageLimitGb: 1,
  });
  await tx.insert(organizationsTable).values([
    { id: organizationId, name: "Step 12 smoke", slug: `step12-${marker}`, status: "active", planId },
    { id: foreignOrganizationId, name: "Step 12 foreign", slug: `step12-foreign-${marker}`, status: "active", planId },
  ]);
  await tx.insert(organizationCustomizationTable).values({ organizationId });
  await tx.insert(permissionGroupsTable).values([
    { id: groupId, organizationId, name: "Owners", description: "Full workspace access" },
    { id: editorGroupId, organizationId, name: "Editors", description: "Create and manage videos" },
    { id: readOnlyGroupId, organizationId, name: "Step 12 readers", description: "Library readers" },
  ]);
  await tx.insert(permissionsTable).values([
    { key: "videos.read", description: "Read videos" },
    { key: "videos.create", description: "Create videos" },
    { key: "videos.delete", description: "Delete videos" },
    { key: "workspace.manage", description: "Manage workspace" },
    { key: "members.manage", description: "Manage members" },
  ]).onConflictDoNothing();
  await tx.insert(groupPermissionsTable).values([
    { groupId, permissionKey: "videos.read" },
    { groupId, permissionKey: "videos.create" },
    { groupId, permissionKey: "workspace.manage" },
    { groupId, permissionKey: "members.manage" },
    { groupId: editorGroupId, permissionKey: "videos.read" },
    { groupId: editorGroupId, permissionKey: "videos.create" },
    { groupId: readOnlyGroupId, permissionKey: "videos.read" },
  ]);
  await tx.insert(providerAccountsTable).values({
    id: accountId, providerKey: "step7-smoke", label: `step12-${marker}`,
    encryptedCredentials: credential, maxZones: 1,
  });
  await tx.insert(providerTenantSpacesTable).values({
    id: spaceRowId, organizationId, providerAccountId: accountId, providerSpaceId,
    idempotencyKey: `step12-${marker}`, state: "created",
  });
  await tx.insert(videosTable).values([
    ...libraryVideos,
    { id: localDeleteId, organizationId, title: "Local delete", status: "ready" as const },
    {
      id: providerDeleteId, organizationId, title: "Provider delete", status: "ready" as const,
      providerAccountId: accountId, providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-provider-asset-${marker}`,
    },
    {
      id: ambiguousDeleteId, organizationId, title: "Ambiguous delete", status: "ready" as const,
      providerAccountId: accountId, providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-ambiguous-asset-${marker}`,
    },
    { id: foreignVideoId, organizationId: foreignOrganizationId, title: "Foreign secret video", status: "ready" as const },
  ]);
  await tx.insert(videoAnalyticsRollupsTable).values([
    ...libraryVideos.map((video, index) => ({
      organizationId, videoId: video.id, day: "2027-02-01", plays: (index * 17) % 101,
    })),
    { organizationId, videoId: localDeleteId, day: "2027-02-01", plays: 5 },
  ]);
  await tx.insert(videoEmbedsTable).values({
    videoId: localDeleteId, embedPath: `/v/${localDeleteId}`, generationVersion: 1,
    generationStatus: "generated", generatedMetadata: { title: "Local delete", description: "", durationSeconds: 0 },
  });
  await tx.insert(webhookEventsTable).values({
    id: webhookId, providerKey: "step7-smoke", receiptDigest: marker, providerEventId: marker,
    organizationId, ownedVideoId: localDeleteId, verificationState: "verified",
    processingState: "processed", signatureValid: true,
  });
  await tx.insert(embedGenerationOutboxTable).values({
    id: outboxId, webhookEventId: webhookId, videoId: localDeleteId,
  });
});
await reconcileSystemVideoDeletePermission();
await reconcileSystemVideoDeletePermission();
const backfilledGroups = await db.select({ groupId: groupPermissionsTable.groupId })
  .from(groupPermissionsTable)
  .where(eq(groupPermissionsTable.permissionKey, "videos.delete"));
assert.equal(backfilledGroups.filter(({ groupId: id }) => id === groupId).length, 1);
assert.equal(backfilledGroups.filter(({ groupId: id }) => id === editorGroupId).length, 1);

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function createSession(label: string, membershipGroupId: string) {
  const email = `step12-${label}-${marker}@example.test`;
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Step 12 ${label}`, email, password: `Step12-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert(user);
  await db.insert(membershipsTable).values({
    organizationId, userId: user.id, groupId: membershipGroupId, status: "active",
  });
  return { cookie, email };
}

type ListEnvelope = {
  items: Array<{ id: string; title: string; description: string; status: string; visibility: string; createdAt: string; plays: number }>;
  nextCursor: string | null;
  total: number;
};

try {
  const owner = await createSession("owner", groupId);
  const editor = await createSession("editor", editorGroupId);
  const viewer = await createSession("viewer", readOnlyGroupId);
  const requestList = async (query = "", cookie = owner.cookie) => {
    const response = await fetch(`${root}/api/videos${query ? `?${query}` : ""}`, { headers: { cookie } });
    return { response, text: await response.text() };
  };
  const workspacePermissions = async (cookie: string) => {
    const response = await fetch(`${root}/api/workspace`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { permissions: string[] }).permissions;
  };
  assert.deepEqual(await workspacePermissions(owner.cookie), ["audit.export", "audit.read", "members.manage", "videos.create", "videos.delete", "videos.read", "workspace.manage"]);
  assert.deepEqual(await workspacePermissions(editor.cookie), ["videos.create", "videos.delete", "videos.read"]);
  assert.deepEqual(await workspacePermissions(viewer.cookie), ["videos.read"]);

  const defaultPage = await requestList();
  assert.equal(defaultPage.response.status, 200);
  assert.equal((JSON.parse(defaultPage.text) as ListEnvelope).items.length, 24, "default page size must be 24");
  assert.equal(defaultPage.text.includes(providerSpaceId), false);
  assert.equal(defaultPage.text.includes(credential), false);
  assert.equal(defaultPage.text.includes("private-provider-asset"), false);
  const firstCursor = (JSON.parse(defaultPage.text) as ListEnvelope).nextCursor;
  assert(firstCursor);
  const [cursorPayload, cursorSignature] = firstCursor.split(".");
  assert(cursorPayload && cursorSignature);
  const tamperedPayload = `${cursorPayload.slice(0, -1)}${cursorPayload.endsWith("A") ? "B" : "A"}.${cursorSignature}`;
  assert.equal((await requestList(`cursor=${encodeURIComponent(tamperedPayload)}`)).response.status, 400);
  const tamperedCursor = `${firstCursor.slice(0, -1)}${firstCursor.endsWith("A") ? "B" : "A"}`;
  assert.equal((await requestList(`cursor=${encodeURIComponent(tamperedCursor)}`)).response.status, 400);

  for (const sort of ["newest", "oldest", "title_asc", "title_desc", "plays_desc"]) {
    const ids: string[] = [];
    const sortedItems: ListEnvelope["items"] = [];
    let cursor: string | null = null;
    let reportedTotal: number | undefined;
    let pageNumber = 0;
    do {
      const parameters = new URLSearchParams({ sort, limit: "7" });
      if (cursor) parameters.set("cursor", cursor);
      const { response, text } = await requestList(parameters.toString());
      assert.equal(response.status, 200, `${sort} page must succeed`);
      const page = JSON.parse(text) as ListEnvelope;
      reportedTotal ??= page.total;
      assert.equal(page.total, reportedTotal);
      ids.push(...page.items.map(({ id }) => id));
      sortedItems.push(...page.items);
      cursor = page.nextCursor;
      pageNumber += 1;
      if (pageNumber === 1) {
        await db.insert(videosTable).values({
          id: randomUUID(), organizationId, title: `Late ${sort} ${marker}`,
          description: "Inserted after the first library page",
          status: "ready", visibility: "private",
          createdAt: new Date(Date.now() + 60_000),
        });
      }
    } while (cursor);
    assert.equal(new Set(ids).size, ids.length, `${sort} pagination must not duplicate rows`);
    assert.equal(ids.length, reportedTotal, `${sort} pagination must not omit rows`);
    for (let index = 1; index < sortedItems.length; index += 1) {
      const previous = sortedItems[index - 1]!;
      const current = sortedItems[index]!;
      const previousKey = sort === "plays_desc" ? previous.plays
        : sort.startsWith("title") ? previous.title : new Date(previous.createdAt).getTime();
      const currentKey = sort === "plays_desc" ? current.plays
        : sort.startsWith("title") ? current.title : new Date(current.createdAt).getTime();
      const ascending = sort === "oldest" || sort === "title_asc";
      assert(
        ascending
          ? previousKey < currentKey || (previousKey === currentKey && previous.id < current.id)
          : previousKey > currentKey || (previousKey === currentKey && previous.id > current.id),
        `${sort} must use the documented key and deterministic id tie-breaker`,
      );
    }
  }

  const snapshotMarker = `snapshot-${marker}`;
  const snapshotIds = Array.from({ length: 5 }, () => randomUUID());
  await db.insert(videosTable).values(snapshotIds.map((id, index) => ({
    id,
    organizationId,
    title: `${snapshotMarker} ${String.fromCharCode(65 + index)}`,
    description: snapshotMarker,
    status: "ready" as const,
    visibility: "private" as const,
  })));
  const snapshotQuery = `search=${encodeURIComponent(snapshotMarker)}&visibility=private&sort=title_asc&limit=1`;
  const snapshotFirst = await requestList(snapshotQuery);
  assert.equal(snapshotFirst.response.status, 200);
  const snapshotFirstPage = JSON.parse(snapshotFirst.text) as ListEnvelope;
  assert.deepEqual(snapshotFirstPage.items.map(({ id }) => id), [snapshotIds[0]]);
  assert.equal(snapshotFirstPage.total, 5);
  assert(snapshotFirstPage.nextCursor);

  await db.update(videosTable).set({ title: `${snapshotMarker} Z` }).where(eq(videosTable.id, snapshotIds[1]));
  await db.update(videosTable).set({ title: "No longer in snapshot search", description: "" })
    .where(eq(videosTable.id, snapshotIds[2]));
  await db.update(videosTable).set({ visibility: "public" }).where(eq(videosTable.id, snapshotIds[3]));
  await db.delete(videosTable).where(eq(videosTable.id, snapshotIds[4]));

  const frozenSnapshotIds = [snapshotFirstPage.items[0]!.id];
  let snapshotCursor: string | null = snapshotFirstPage.nextCursor;
  while (snapshotCursor) {
    const pageResult = await requestList(`${snapshotQuery}&cursor=${encodeURIComponent(snapshotCursor)}`);
    assert.equal(pageResult.response.status, 200);
    const page = JSON.parse(pageResult.text) as ListEnvelope;
    assert.equal(page.total, 5);
    frozenSnapshotIds.push(...page.items.map(({ id }) => id));
    snapshotCursor = page.nextCursor;
  }
  assert.deepEqual(frozenSnapshotIds, snapshotIds, "metadata, filter, and delete mutations must not alter an active snapshot");
  const freshSnapshot = await requestList(snapshotQuery);
  const freshSnapshotPage = JSON.parse(freshSnapshot.text) as ListEnvelope;
  assert.equal(freshSnapshotPage.total, 2);
  assert.deepEqual(freshSnapshotPage.items.map(({ id }) => id), [snapshotIds[0], snapshotIds[1]]);

  const playsMarker = `plays-snapshot-${marker}`;
  const playsSnapshotIds = Array.from({ length: 3 }, () => randomUUID());
  await db.insert(videosTable).values(playsSnapshotIds.map((id, index) => ({
    id, organizationId, title: `${playsMarker}-${index}`, status: "ready" as const,
  })));
  await db.insert(videoAnalyticsRollupsTable).values(playsSnapshotIds.map((videoId, index) => ({
    organizationId, videoId, day: "2027-02-02", plays: 30 - index * 10,
  })));
  const playsQuery = `search=${encodeURIComponent(playsMarker)}&sort=plays_desc&limit=1`;
  const playsFirst = JSON.parse((await requestList(playsQuery)).text) as ListEnvelope;
  assert.deepEqual(playsFirst.items.map(({ id }) => id), [playsSnapshotIds[0]]);
  assert(playsFirst.nextCursor);
  await db.update(videoAnalyticsRollupsTable).set({ plays: 5 })
    .where(eq(videoAnalyticsRollupsTable.videoId, playsSnapshotIds[1]));
  await db.update(videoAnalyticsRollupsTable).set({ plays: 40 })
    .where(eq(videoAnalyticsRollupsTable.videoId, playsSnapshotIds[2]));
  await db.delete(videosTable).where(eq(videosTable.id, playsSnapshotIds[0]));
  const frozenPlaysIds = [playsFirst.items[0]!.id];
  let playsCursor: string | null = playsFirst.nextCursor;
  while (playsCursor) {
    const page = JSON.parse((await requestList(
      `${playsQuery}&cursor=${encodeURIComponent(playsCursor)}`,
    )).text) as ListEnvelope;
    frozenPlaysIds.push(...page.items.map(({ id }) => id));
    playsCursor = page.nextCursor;
  }
  assert.deepEqual(frozenPlaysIds, playsSnapshotIds, "analytics and delete mutations must not reorder an active snapshot");
  const freshPlays = JSON.parse((await requestList(playsQuery)).text) as ListEnvelope;
  assert.deepEqual(freshPlays.items.map(({ id }) => id), [playsSnapshotIds[2]]);
  assert.equal(freshPlays.total, 2);

  for (const status of ["created", "uploading", "processing", "ready", "error"]) {
    const { response, text } = await requestList(`status=${status}&limit=100`);
    assert.equal(response.status, 200);
    assert((JSON.parse(text) as ListEnvelope).items.every((video) => video.status === status));
  }
  for (const visibility of ["private", "unlisted", "public"]) {
    const { response, text } = await requestList(`visibility=${visibility}&limit=100`);
    assert.equal(response.status, 200);
    assert((JSON.parse(text) as ListEnvelope).items.every((video) => video.visibility === visibility));
  }
  const searched = await requestList(`search=${encodeURIComponent("  needle  ")}&limit=100`);
  assert.equal(searched.response.status, 200);
  const searchItems = (JSON.parse(searched.text) as ListEnvelope).items;
  assert(searchItems.some((video) => video.title.includes("Needle")));
  assert(searchItems.some((video) => video.description.includes("haystack needle")));

  for (const query of ["cursor=not-a-valid-cursor", "limit=0", "limit=101", "status=bogus", "visibility=bogus", "sort=bogus"]) {
    assert.equal((await requestList(query)).response.status, 400, `${query} must be rejected`);
  }
  const crossTenantList = await requestList(`search=${encodeURIComponent("Foreign secret")}`);
  assert.equal((JSON.parse(crossTenantList.text) as ListEnvelope).total, 0);
  assert.equal((await fetch(`${root}/api/videos/${foreignVideoId}`, {
    method: "DELETE", headers: { cookie: owner.cookie },
  })).status, 404);
  assert.equal((await requestList("", "")).response.status, 401);
  assert.equal((await fetch(`${root}/api/videos/${localDeleteId}`, {
    method: "DELETE", headers: { cookie: viewer.cookie },
  })).status, 403);

  assert.equal((await fetch(`${root}/api/videos/${localDeleteId}`, {
    method: "DELETE", headers: { cookie: owner.cookie },
  })).status, 204);
  assert.equal((await db.select().from(videosTable).where(eq(videosTable.id, localDeleteId))).length, 0);
  assert.equal((await db.select().from(videoAnalyticsRollupsTable).where(eq(videoAnalyticsRollupsTable.videoId, localDeleteId))).length, 0);
  assert.equal((await db.select().from(videoEmbedsTable).where(eq(videoEmbedsTable.videoId, localDeleteId))).length, 0);
  assert.equal((await db.select().from(embedGenerationOutboxTable).where(eq(embedGenerationOutboxTable.videoId, localDeleteId))).length, 0);

  const provider = videoProviders.resolve("step7-smoke") as unknown as {
    deleteAssetCalls: number;
    failNextDeleteAfterAcceptance: boolean;
  };
  const callsBefore = provider.deleteAssetCalls;
  const providerResponse = await fetch(`${root}/api/videos/${providerDeleteId}`, {
    method: "DELETE", headers: { cookie: owner.cookie },
  });
  assert.equal(providerResponse.status, 204);
  assert.equal(provider.deleteAssetCalls, callsBefore + 1);
  assert.equal((await db.select().from(videosTable).where(eq(videosTable.id, providerDeleteId))).length, 0);

  provider.failNextDeleteAfterAcceptance = true;
  const ambiguousResponse = await fetch(`${root}/api/videos/${ambiguousDeleteId}`, {
    method: "DELETE", headers: { cookie: owner.cookie },
  });
  assert.equal(ambiguousResponse.status, 503);
  const ambiguousBody = await ambiguousResponse.text();
  assert.equal(ambiguousBody.includes(providerSpaceId), false);
  assert.equal(ambiguousBody.includes(credential), false);
  const callsAfterAmbiguity = provider.deleteAssetCalls;
  const [quarantined] = await db.select().from(videosTable).where(eq(videosTable.id, ambiguousDeleteId));
  assert(quarantined?.deletionClaim);
  assert.equal(quarantined?.reconciliationRequired, "provider asset deletion outcome unknown");
  assert.equal((await fetch(`${root}/api/videos/${ambiguousDeleteId}`, {
    method: "DELETE", headers: { cookie: owner.cookie },
  })).status, 409);
  assert.equal(provider.deleteAssetCalls, callsAfterAmbiguity, "ambiguous provider deletion must not be retried");

  await db.delete(videoLibrarySnapshotsTable)
    .where(eq(videoLibrarySnapshotsTable.organizationId, organizationId));
  const capExpiry = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(videoLibrarySnapshotsTable).values(Array.from({ length: 63 }, () => ({
    id: randomUUID(),
    organizationId,
    scopeHash: "near-cap-smoke",
    total: 0,
    expiresAt: capExpiry,
  })));
  const capRequests = await Promise.all([
    requestList(`search=${encodeURIComponent(marker)}&sort=newest&limit=1`),
    requestList(`search=${encodeURIComponent(marker)}&sort=newest&limit=1`),
  ]);
  assert.deepEqual(
    capRequests.map(({ response }) => response.status).sort(),
    [200, 429],
    "snapshot admission must serialize concurrent requests at the tenant cap",
  );
  const [activeSnapshotCount] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(videoLibrarySnapshotsTable)
    .where(eq(videoLibrarySnapshotsTable.organizationId, organizationId));
  assert.equal(activeSnapshotCount?.count, 64);

  process.stdout.write("Step 12 video library smoke passed\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(webhookEventsTable).where(eq(webhookEventsTable.id, webhookId));
  await db.delete(videosTable).where(and(eq(videosTable.organizationId, organizationId)));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, spaceRowId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  await db.delete(usersTable).where(eq(usersTable.email, `step12-owner-${marker}@example.test`));
  await db.delete(usersTable).where(eq(usersTable.email, `step12-editor-${marker}@example.test`));
  await db.delete(usersTable).where(eq(usersTable.email, `step12-viewer-${marker}@example.test`));
  await pool.end();
}