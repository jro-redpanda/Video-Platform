import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "test") throw new Error("Step 13 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  db, pool, foldersTable, groupPermissionsTable, membershipsTable, organizationCustomizationTable,
  organizationsTable, permissionGroupsTable, permissionsTable, plansTable, providerAccountsTable,
  providerTenantSpacesTable, usersTable, videosTable,
} = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { default: app } = await import("./app");

const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const ownerGroupId = randomUUID();
const viewerGroupId = randomUUID();
const accountId = randomUUID();
const spaceId = randomUUID();
const foreignFolderId = randomUUID();

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId,
    code: `step13-${marker}`,
    name: "Step 13 smoke",
    storageLimitGb: 10,
    entitlements: { "limits.max_videos": 100, "limits.max_storage_gb": 10 },
  });
  await tx.insert(organizationsTable).values([
    { id: organizationId, name: "Step 13", slug: `step13-${marker}`, status: "active", planId },
    { id: foreignOrganizationId, name: "Step 13 foreign", slug: `step13-foreign-${marker}`, status: "active", planId },
  ]);
  await tx.insert(organizationCustomizationTable).values({ organizationId });
  await tx.insert(permissionGroupsTable).values([
    { id: ownerGroupId, organizationId, name: "Step 13 owners", description: "Folder managers" },
    { id: viewerGroupId, organizationId, name: "Step 13 viewers", description: "Folder viewers" },
  ]);
  await tx.insert(permissionsTable).values([
    { key: "videos.read", description: "Read videos" },
    { key: "videos.create", description: "Create videos" },
    { key: "videos.update", description: "Update videos" },
  ]).onConflictDoNothing();
  await tx.insert(groupPermissionsTable).values([
    { groupId: ownerGroupId, permissionKey: "videos.read" },
    { groupId: ownerGroupId, permissionKey: "videos.create" },
    { groupId: ownerGroupId, permissionKey: "videos.update" },
    { groupId: viewerGroupId, permissionKey: "videos.read" },
  ]);
  await tx.insert(providerAccountsTable).values({
    id: accountId, providerKey: "step7-smoke", label: `step13-${marker}`,
    encryptedCredentials: `private-${marker}`, maxZones: 1,
  });
  await tx.insert(providerTenantSpacesTable).values({
    id: spaceId, organizationId, providerAccountId: accountId,
    providerSpaceId: `step13-space-${marker}`, idempotencyKey: `step13-${marker}`, state: "created",
  });
  await tx.insert(foldersTable).values({
    id: foreignFolderId, organizationId: foreignOrganizationId, name: "Foreign secret",
  });
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function session(label: string, groupId: string) {
  const email = `step13-${label}-${marker}@example.test`;
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Step 13 ${label}`, email, password: `Step13-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert(user);
  await db.insert(membershipsTable).values({
    organizationId, userId: user.id, groupId, status: "active",
  });
  return { cookie, email };
}

async function request(cookie: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${root}/api${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) as Record<string, unknown> : undefined };
}

async function createFolder(cookie: string, name: string, parentId: string | null = null) {
  const result = await request(cookie, "/folders", {
    method: "POST", body: JSON.stringify({ name, parentId }),
  });
  assert.equal(result.response.status, 201, result.text);
  return result.json as { id: string; name: string; parentId: string | null; ancestors: Array<{ id: string; name: string }> };
}

try {
  const owner = await session("owner", ownerGroupId);
  const viewer = await session("viewer", viewerGroupId);
  const rootFolder = await createFolder(owner.cookie, " Projects ");
  assert.equal(rootFolder.name, "Projects");
  const child = await createFolder(owner.cookie, "Launches", rootFolder.id);

  const roots = await request(owner.cookie, "/folders?parentId=root");
  assert.equal(roots.response.status, 200);
  assert((roots.json as unknown as Array<{ id: string }>).some(({ id }) => id === rootFolder.id));
  const children = await request(owner.cookie, `/folders?parentId=${rootFolder.id}`);
  assert.equal(children.response.status, 200);
  assert.equal((children.json as unknown as Array<{ id: string }>)[0]?.id, child.id);
  const detail = await request(owner.cookie, `/folders/${child.id}`);
  assert.equal(detail.response.status, 200);
  assert.deepEqual((detail.json as { ancestors: unknown }).ancestors, [{ id: rootFolder.id, name: "Projects" }]);

  assert.equal((await request(owner.cookie, "/folders", {
    method: "POST", body: JSON.stringify({ name: "projects", parentId: null }),
  })).response.status, 409);
  assert.equal((await request(owner.cookie, "/folders", {
    method: "POST", body: JSON.stringify({ name: "LAUNCHES", parentId: rootFolder.id }),
  })).response.status, 409);

  const renamed = await request(owner.cookie, `/folders/${child.id}`, {
    method: "PATCH", body: JSON.stringify({ name: "Campaigns" }),
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.json?.name, "Campaigns");
  assert.equal((await request(owner.cookie, `/folders/${rootFolder.id}`, {
    method: "PATCH", body: JSON.stringify({ parentId: child.id }),
  })).response.status, 409);
  assert.equal((await request(owner.cookie, `/folders/${child.id}`, {
    method: "PATCH", body: JSON.stringify({ parentId: child.id }),
  })).response.status, 409);

  let deepest = child;
  for (let depth = 3; depth <= 20; depth += 1) deepest = await createFolder(owner.cookie, `Depth ${depth}`, deepest.id);
  assert.equal((await request(owner.cookie, "/folders", {
    method: "POST", body: JSON.stringify({ name: "Too deep", parentId: deepest.id }),
  })).response.status, 409);

  const populated = await createFolder(owner.cookie, "Populated");
  const videoIds = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(videosTable).values(videoIds.map((id, index) => ({
    id, organizationId, folderId: populated.id, title: `Folder video ${index}`,
  })));
  assert.equal((await request(owner.cookie, `/folders/${populated.id}`, { method: "DELETE" })).response.status, 409);

  const firstPage = await request(owner.cookie, `/videos?folderId=${populated.id}&limit=1`);
  assert.equal(firstPage.response.status, 200);
  const envelope = firstPage.json as { items: Array<{ folderId: string; folderName: string; folderPath: unknown[] }>; nextCursor: string };
  assert.equal(envelope.items[0]?.folderId, populated.id);
  assert.equal(envelope.items[0]?.folderName, "Populated");
  assert.equal(envelope.items[0]?.folderPath.length, 1);
  assert(envelope.nextCursor);
  assert.equal((await request(owner.cookie,
    `/videos?folderId=root&limit=1&cursor=${encodeURIComponent(envelope.nextCursor)}`)).response.status, 400);
  const tampered = `${envelope.nextCursor.slice(0, -1)}${envelope.nextCursor.endsWith("A") ? "B" : "A"}`;
  assert.equal((await request(owner.cookie,
    `/videos?folderId=${populated.id}&limit=1&cursor=${encodeURIComponent(tampered)}`)).response.status, 400);
  assert.equal((await request(owner.cookie,
    `/videos?folderId=${foreignFolderId}`)).response.status, 404);

  const moved = await request(owner.cookie, `/videos/${videoIds[0]}`, {
    method: "PATCH", body: JSON.stringify({ folderId: null }),
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.json?.folderId, null);
  assert.equal((await request(owner.cookie, `/videos/${videoIds[0]}`, {
    method: "PATCH", body: JSON.stringify({ folderId: foreignFolderId }),
  })).response.status, 404);

  const uploadKey = `step13-upload-${marker}`;
  const uploadBody = {
    title: "Assigned upload", fileName: "assigned.mp4", contentType: "video/mp4",
    contentLength: 1024, folderId: populated.id,
  };
  const initialized = await request(owner.cookie, "/videos/upload-init", {
    method: "POST", headers: { "Idempotency-Key": uploadKey }, body: JSON.stringify(uploadBody),
  });
  assert.equal(initialized.response.status, 201, initialized.text);
  const uploadVideoId = initialized.json?.videoId as string;
  const retry = await request(owner.cookie, "/videos/upload-init", {
    method: "POST", headers: { "Idempotency-Key": uploadKey }, body: JSON.stringify(uploadBody),
  });
  assert.equal(retry.response.status, 200);
  const [assigned] = await db.select({ folderId: videosTable.folderId }).from(videosTable)
    .where(eq(videosTable.id, uploadVideoId));
  assert.equal(assigned?.folderId, populated.id);

  const empty = await createFolder(owner.cookie, "Empty");
  assert.equal((await request(owner.cookie, `/folders/${empty.id}`, { method: "DELETE" })).response.status, 204);

  const raceFolder = await createFolder(owner.cookie, "Move delete race");
  const [raceMove, raceDelete] = await Promise.all([
    request(owner.cookie, `/videos/${videoIds[0]}`, {
      method: "PATCH", body: JSON.stringify({ folderId: raceFolder.id }),
    }),
    request(owner.cookie, `/folders/${raceFolder.id}`, { method: "DELETE" }),
  ]);
  const raceStatuses = [raceMove.response.status, raceDelete.response.status];
  assert(
    (raceStatuses[0] === 200 && raceStatuses[1] === 409)
      || (raceStatuses[0] === 404 && raceStatuses[1] === 204),
    `concurrent video move/folder delete must serialize without a server error, got ${raceStatuses.join("/")}`,
  );
  if (raceMove.response.status === 200) {
    assert.equal((await request(owner.cookie, `/videos/${videoIds[0]}`, {
      method: "PATCH", body: JSON.stringify({ folderId: null }),
    })).response.status, 200);
    assert.equal((await request(owner.cookie, `/folders/${raceFolder.id}`, {
      method: "DELETE",
    })).response.status, 204);
  }

  assert.equal((await request(viewer.cookie, "/folders", {
    method: "POST", body: JSON.stringify({ name: "Forbidden" }),
  })).response.status, 403);
  assert.equal((await request(viewer.cookie, "/folders?parentId=root")).response.status, 200);
  assert.equal((await request(owner.cookie, `/folders/${foreignFolderId}`)).response.status, 404);
  assert.equal((await request(owner.cookie, `/folders/${child.id}`, {
    method: "PATCH", body: JSON.stringify({ parentId: foreignFolderId }),
  })).response.status, 404);

  let compositeProtected = false;
  try {
    await db.insert(videosTable).values({
      organizationId, folderId: foreignFolderId, title: "Must fail composite FK",
    });
  } catch (error) {
    compositeProtected = hasPgCode(error, "23503");
  }
  assert(compositeProtected, "composite video-folder FK must reject cross-tenant assignment");
  process.stdout.write("Step 13 nested folder smoke passed\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(videosTable).where(eq(videosTable.organizationId, organizationId));
  await db.delete(foldersTable).where(eq(foldersTable.organizationId, organizationId));
  await db.delete(foldersTable).where(eq(foldersTable.organizationId, foreignOrganizationId));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, spaceId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  await db.delete(usersTable).where(and(
    eq(usersTable.email, `step13-owner-${marker}@example.test`),
  ));
  await db.delete(usersTable).where(eq(usersTable.email, `step13-viewer-${marker}@example.test`));
  await pool.end();
}

function hasPgCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: string }).code === code) return true;
  return "cause" in error && hasPgCode((error as { cause?: unknown }).cause, code);
}