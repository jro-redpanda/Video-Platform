import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "test") throw new Error("Step 14 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  auditLogsTable, db, foldersTable, groupPermissionsTable, membershipsTable,
  organizationCustomizationTable, organizationsTable, permissionGroupsTable, permissionsTable,
  plansTable, pool, providerAccountsTable, providerTenantSpacesTable, usersTable, videosTable,
} = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { default: app } = await import("./app");
const { videoProviders } = await import("./lib/provider-registry");

const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const fullGroupId = randomUUID();
const updateGroupId = randomUUID();
const deleteGroupId = randomUUID();
const viewerGroupId = randomUUID();
const accountId = randomUUID();
const spaceRowId = randomUUID();
const providerSpaceId = `private-step14-space-${marker}`;
const folderId = randomUUID();
const foreignFolderId = randomUUID();
const updateIds: string[] = [randomUUID(), randomUUID()];
const foreignVideoId = randomUUID();
const localDeleteId = randomUUID();
const providerDeleteId = randomUUID();
const ambiguousDeleteId = randomUUID();

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId, code: `step14-${marker}`, name: "Step 14 smoke", storageLimitGb: 10,
  });
  await tx.insert(organizationsTable).values([
    { id: organizationId, name: "Step 14", slug: `step14-${marker}`, status: "active", planId },
    { id: foreignOrganizationId, name: "Step 14 foreign", slug: `step14-foreign-${marker}`, status: "active", planId },
  ]);
  await tx.insert(organizationCustomizationTable).values({ organizationId });
  await tx.insert(permissionGroupsTable).values([
    { id: fullGroupId, organizationId, name: `Full ${marker}`, description: "Bulk update and delete" },
    { id: updateGroupId, organizationId, name: `Update ${marker}`, description: "Bulk update only" },
    { id: deleteGroupId, organizationId, name: `Delete ${marker}`, description: "Bulk delete only" },
    { id: viewerGroupId, organizationId, name: `Viewer ${marker}`, description: "No mutation permissions" },
  ]);
  await tx.insert(permissionsTable).values([
    { key: "videos.update", description: "Update videos" },
    { key: "videos.delete", description: "Delete videos" },
  ]).onConflictDoNothing();
  await tx.insert(groupPermissionsTable).values([
    { groupId: fullGroupId, permissionKey: "videos.update" },
    { groupId: fullGroupId, permissionKey: "videos.delete" },
    { groupId: updateGroupId, permissionKey: "videos.update" },
    { groupId: deleteGroupId, permissionKey: "videos.delete" },
  ]);
  await tx.insert(providerAccountsTable).values({
    id: accountId, providerKey: "step7-smoke", label: `step14-${marker}`,
    encryptedCredentials: `private-step14-credential-${marker}`, maxZones: 1,
  });
  await tx.insert(providerTenantSpacesTable).values({
    id: spaceRowId, organizationId, providerAccountId: accountId, providerSpaceId,
    idempotencyKey: `step14-${marker}`, state: "created",
  });
  await tx.insert(foldersTable).values([
    { id: folderId, organizationId, name: "Bulk destination" },
    { id: foreignFolderId, organizationId: foreignOrganizationId, name: "Foreign destination" },
  ]);
  await tx.insert(videosTable).values([
    ...updateIds.map((id, index) => ({ id, organizationId, title: `Bulk update ${index}` })),
    { id: foreignVideoId, organizationId: foreignOrganizationId, title: "Foreign secret" },
    { id: localDeleteId, organizationId, title: "Bulk local delete" },
    {
      id: providerDeleteId, organizationId, title: "Bulk provider delete",
      providerAccountId: accountId, providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-step14-provider-${marker}`,
    },
    {
      id: ambiguousDeleteId, organizationId, title: "Bulk ambiguous delete",
      providerAccountId: accountId, providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-step14-ambiguous-${marker}`,
    },
  ]);
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function session(label: string, groupId: string) {
  const email = `step14-${label}-${marker}@example.test`;
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Step 14 ${label}`, email, password: `Step14-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert(user);
  await db.insert(membershipsTable).values({ organizationId, userId: user.id, groupId, status: "active" });
  return { cookie, email };
}

async function request(cookie: string, path: string, body: unknown, method = "PATCH") {
  const response = await fetch(`${root}/api${path}`, {
    method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) as {
    succeeded: string[];
    failed: Array<{ videoId: string; status: number; error: string }>;
  } : undefined };
}

try {
  const full = await session("full", fullGroupId);
  const updater = await session("updater", updateGroupId);
  const deleter = await session("deleter", deleteGroupId);
  const viewer = await session("viewer", viewerGroupId);

  for (const body of [
    { operation: "visibility", videoIds: [], visibility: "public" },
    { operation: "visibility", videoIds: [updateIds[0], updateIds[0]], visibility: "public" },
    { operation: "visibility", videoIds: Array.from({ length: 51 }, () => randomUUID()), visibility: "public" },
    { operation: "visibility", videoIds: updateIds },
    { operation: "move", videoIds: updateIds },
    { operation: "move", videoIds: updateIds, folderId: null, visibility: "public" },
    { operation: "visibility", videoIds: updateIds, folderId: null, visibility: "public" },
    { operation: "wrong-discriminator", videoIds: updateIds, visibility: "public" },
    { operation: "visibility", videoIds: updateIds, visibility: "public", unexpected: true },
    { operation: "visibility", videoIds: ["not-a-uuid"], visibility: "public" },
  ]) assert.equal((await request(full.cookie, "/videos/bulk", body)).response.status, 400);
  for (const body of [
    { videoIds: [] },
    { videoIds: [localDeleteId, localDeleteId] },
    { videoIds: Array.from({ length: 26 }, () => randomUUID()) },
    { videoIds: ["not-a-uuid"] },
  ]) assert.equal((await request(full.cookie, "/videos/bulk-delete", body, "POST")).response.status, 400);

  assert.equal((await request(viewer.cookie, "/videos/bulk", {
    operation: "visibility", videoIds: updateIds, visibility: "public",
  })).response.status, 403);
  assert.equal((await request(updater.cookie, "/videos/bulk-delete", { videoIds: [localDeleteId] }, "POST")).response.status, 403);
  assert.equal((await request(deleter.cookie, "/videos/bulk", {
    operation: "visibility", videoIds: updateIds, visibility: "public",
  })).response.status, 403);

  const missingId = randomUUID();
  const visibility = await request(updater.cookie, "/videos/bulk", {
    operation: "visibility", videoIds: [updateIds[1], missingId, foreignVideoId, updateIds[0]], visibility: "public",
  });
  assert.equal(visibility.response.status, 200);
  assert.deepEqual(visibility.json?.succeeded, [updateIds[1], updateIds[0]]);
  assert.deepEqual(visibility.json?.failed.map(({ videoId, status }) => [videoId, status]), [
    [missingId, 404], [foreignVideoId, 404],
  ]);
  assert.equal(visibility.text.includes("provider"), false);
  const audits = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organizationId), eq(auditLogsTable.action, "video.visibility_changed"),
  ));
  assert.equal(audits.filter(({ subjectId }) => updateIds.includes(subjectId ?? "")).length, 2);

  const invalidDestination = await request(full.cookie, "/videos/bulk", {
    operation: "move", videoIds: updateIds, folderId: foreignFolderId,
  });
  assert.deepEqual(invalidDestination.json?.succeeded, []);
  assert.deepEqual(invalidDestination.json?.failed.map(({ videoId }) => videoId), updateIds);
  assert(invalidDestination.json?.failed.every(({ status }) => status === 404));
  const moved = await request(full.cookie, "/videos/bulk", { operation: "move", videoIds: updateIds, folderId });
  assert.deepEqual(moved.json?.succeeded, updateIds);
  assert((await db.select().from(videosTable).where(eq(videosTable.folderId, folderId))).length >= 2);
  const rooted = await request(full.cookie, "/videos/bulk", { operation: "move", videoIds: updateIds, folderId: null });
  assert.deepEqual(rooted.json?.succeeded, updateIds);

  const raceFolderId = randomUUID();
  await db.insert(foldersTable).values({ id: raceFolderId, organizationId, name: "Step 14 race" });
  const [raceMove, raceDelete] = await Promise.all([
    request(full.cookie, "/videos/bulk", { operation: "move", videoIds: [updateIds[0]], folderId: raceFolderId }),
    fetch(`${root}/api/folders/${raceFolderId}`, { method: "DELETE", headers: { cookie: full.cookie } }),
  ]);
  assert(
    (raceMove.response.status === 200 && raceMove.json?.succeeded.length === 1 && raceDelete.status === 409)
      || (raceMove.response.status === 200 && raceMove.json?.failed[0]?.status === 404 && raceDelete.status === 204),
  );

  const provider = videoProviders.resolve("step7-smoke") as unknown as {
    deleteAssetCalls: number;
    failNextDeleteAfterAcceptance: boolean;
  };
  const beforeDelete = provider.deleteAssetCalls;
  const deleted = await request(full.cookie, "/videos/bulk-delete", {
    videoIds: [providerDeleteId, randomUUID(), localDeleteId],
  }, "POST");
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.json?.succeeded, [providerDeleteId, localDeleteId]);
  assert.equal(deleted.json?.failed.length, 1);
  assert.equal(deleted.json?.failed[0]?.status, 404);
  assert.equal(provider.deleteAssetCalls, beforeDelete + 1);

  provider.failNextDeleteAfterAcceptance = true;
  const ambiguous = await request(full.cookie, "/videos/bulk-delete", { videoIds: [ambiguousDeleteId] }, "POST");
  assert.equal(ambiguous.response.status, 200);
  assert.equal(ambiguous.json?.failed[0]?.status, 503);
  assert.equal(ambiguous.text.includes(providerSpaceId), false);
  assert.equal(ambiguous.text.includes(`private-step14-ambiguous-${marker}`), false);
  const callsAfterAmbiguity = provider.deleteAssetCalls;
  const retry = await request(full.cookie, "/videos/bulk-delete", { videoIds: [ambiguousDeleteId] }, "POST");
  assert.equal(retry.json?.failed[0]?.status, 409);
  assert.equal(provider.deleteAssetCalls, callsAfterAmbiguity);
  const [quarantined] = await db.select().from(videosTable).where(eq(videosTable.id, ambiguousDeleteId));
  assert(quarantined?.deletionClaim);
  assert.equal(quarantined.reconciliationRequired, "provider asset deletion outcome unknown");

  process.stdout.write("Step 14 bulk video actions smoke passed\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(videosTable).where(eq(videosTable.organizationId, organizationId));
  await db.delete(foldersTable).where(eq(foldersTable.organizationId, organizationId));
  await db.delete(foldersTable).where(eq(foldersTable.organizationId, foreignOrganizationId));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, spaceRowId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  await db.delete(usersTable).where(and(
    eq(usersTable.email, `step14-full-${marker}@example.test`),
  ));
  await db.delete(usersTable).where(eq(usersTable.email, `step14-updater-${marker}@example.test`));
  await db.delete(usersTable).where(eq(usersTable.email, `step14-deleter-${marker}@example.test`));
  await db.delete(usersTable).where(eq(usersTable.email, `step14-viewer-${marker}@example.test`));
  await pool.end();
}