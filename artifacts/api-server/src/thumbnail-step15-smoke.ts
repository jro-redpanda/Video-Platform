import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ThumbnailStorage } from "./lib/thumbnail-storage";

if (process.env.NODE_ENV !== "test") throw new Error("Step 15 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  db, groupPermissionsTable, membershipsTable, objectCleanupOutboxTable,
  organizationCustomizationTable, organizationsTable, permissionGroupsTable,
  permissionsTable, plansTable, pool, providerAccountsTable, providerTenantSpacesTable,
  thumbnailUploadIntentsTable, usersTable, videosTable,
} = await import("@workspace/db");
const { and, eq, sql } = await import("drizzle-orm");
const { cleanupThumbnailObjects, MAX_THUMBNAIL_CLEANUP_ATTEMPTS } =
  await import("./lib/thumbnail-cleanup");
const { default: app } = await import("./app");
const { videoProviders } = await import("./lib/provider-registry");

class FakeStorage implements ThumbnailStorage {
  objects = new Map<string, { bytes: Buffer; contentType: string; generation?: string }>();
  signedKey: string | undefined;
  failDeletes = 0;
  failDeleteKeys = new Set<string>();
  permanentFailDeleteKeys = new Set<string>();
  deleteCalls = 0;
  deleteAttempts = new Map<string, number>();
  deleted: string[] = [];
  blockMetadata = false;
  metadataEntered: (() => void) | undefined;
  releaseMetadata: (() => void) | undefined;
  mutateAfterRead = false;
  failAfterCopy = false;
  async createSignedPutUrl(objectKey: string, contentType: string) {
    this.signedKey = objectKey;
    return {
      uploadUrl: `https://upload.invalid/${randomUUID()}`,
      requiredHeaders: { "Content-Type": contentType },
    };
  }
  async getMetadata(objectKey: string, generation?: string) {
    const object = this.objects.get(objectKey);
    if (!object) {
      const { ThumbnailObjectNotFoundError } = await import("./lib/thumbnail-storage");
      throw new ThumbnailObjectNotFoundError();
    }
    if (generation && generation !== (object.generation ?? "1")) {
      const { ThumbnailObjectNotFoundError } = await import("./lib/thumbnail-storage");
      throw new ThumbnailObjectNotFoundError();
    }
    if (this.blockMetadata) {
      this.blockMetadata = false;
      await new Promise<void>((resolve) => {
        this.releaseMetadata = resolve;
        this.metadataEntered?.();
      });
    }
    return { contentType: object.contentType, size: object.bytes.length, generation: object.generation ?? "1" };
  }
  async readRange(objectKey: string, generation: string, start: number, end: number) {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("missing");
    if ((object.generation ?? "1") !== generation) throw new Error("generation changed");
    const bytes = object.bytes.subarray(start, end + 1);
    if (this.mutateAfterRead) {
      this.mutateAfterRead = false;
      object.generation = String(Number(generation) + 1);
      object.bytes = Buffer.from(object.bytes);
      object.bytes[object.bytes.length - 1] ^= 1;
    }
    return bytes;
  }
  async promoteObject(sourceKey: string, sourceGeneration: string, destinationKey: string, contentType: string) {
    const source = this.objects.get(sourceKey);
    if (!source || (source.generation ?? "1") !== sourceGeneration) throw new Error("source generation changed");
    if (this.objects.has(destinationKey)) throw new Error("destination already exists");
    const promoted = { bytes: Buffer.from(source.bytes), contentType, generation: "1" };
    this.objects.set(destinationKey, promoted);
    if (this.failAfterCopy) {
      this.failAfterCopy = false;
      throw new Error("copy outcome failed after object creation");
    }
    return { contentType, size: promoted.bytes.length, generation: promoted.generation };
  }
  createReadStream(objectKey: string, generation?: string) {
    const object = this.objects.get(objectKey);
    if (!object) return Readable.from([]);
    if (generation && generation !== (object.generation ?? "1")) {
      return Readable.from((async function* () { throw new Error("generation changed"); })());
    }
    return Readable.from([object.bytes]);
  }
  async deleteObject(objectKey: string) {
    this.deleteCalls++;
    this.deleteAttempts.set(objectKey, (this.deleteAttempts.get(objectKey) ?? 0) + 1);
    if (this.failDeleteKeys.delete(objectKey) || this.permanentFailDeleteKeys.has(objectKey)
      || this.failDeletes-- > 0) throw new Error("transient fake deletion failure");
    this.objects.delete(objectKey);
    this.deleted.push(objectKey);
  }
}

const storage = new FakeStorage();
app.locals.thumbnailStorage = storage;
const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const fullGroupId = randomUUID();
const viewerGroupId = randomUUID();
const videoId = randomUUID();
const privateVideoId = randomUUID();
const foreignVideoId = randomUUID();
const deleteVideoId = randomUUID();
const ambiguousVideoId = randomUUID();
const raceVideoId = randomUUID();
const legacyVideoId = randomUUID();
const legacyVersion = randomUUID();
const legacyKey = `thumbnails/${organizationId}/${legacyVideoId}/legacy-signed-object`;
const legacyMutableUntil = new Date(Date.now() + 5 * 60_000);
const providerAccountId = randomUUID();
const providerSpaceRowId = randomUUID();
const providerSpaceId = `private-step15-space-${marker}`;

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId, code: `step15-${marker}`, name: "Step 15 smoke", storageLimitGb: 10,
  });
  await tx.insert(organizationsTable).values([
    { id: organizationId, name: "Step 15", slug: `step15-${marker}`, status: "active", planId },
    { id: foreignOrganizationId, name: "Step 15 foreign", slug: `step15-foreign-${marker}`, status: "active", planId },
  ]);
  await tx.insert(organizationCustomizationTable).values([
    { organizationId },
    { organizationId: foreignOrganizationId },
  ]);
  await tx.insert(permissionGroupsTable).values([
    { id: fullGroupId, organizationId, name: `Full ${marker}`, description: "Thumbnail management" },
    { id: viewerGroupId, organizationId, name: `Viewer ${marker}`, description: "Read only" },
  ]);
  await tx.insert(permissionsTable).values([
    { key: "videos.read", description: "Read videos" },
    { key: "videos.update", description: "Update videos" },
    { key: "videos.delete", description: "Delete videos" },
  ]).onConflictDoNothing();
  await tx.insert(groupPermissionsTable).values([
    { groupId: fullGroupId, permissionKey: "videos.read" },
    { groupId: fullGroupId, permissionKey: "videos.update" },
    { groupId: fullGroupId, permissionKey: "videos.delete" },
    { groupId: viewerGroupId, permissionKey: "videos.read" },
  ]);
  await tx.insert(providerAccountsTable).values({
    id: providerAccountId,
    providerKey: "step7-smoke",
    label: `step15-${marker}`,
    encryptedCredentials: `private-step15-credential-${marker}`,
    maxZones: 1,
  });
  await tx.insert(providerTenantSpacesTable).values({
    id: providerSpaceRowId,
    organizationId,
    providerAccountId,
    providerSpaceId,
    idempotencyKey: `step15-${marker}`,
    state: "created",
  });
  await tx.insert(videosTable).values([
    { id: videoId, organizationId, title: "Unlisted thumbnail", visibility: "unlisted" },
    { id: privateVideoId, organizationId, title: "Private thumbnail", visibility: "private" },
    { id: deleteVideoId, organizationId, title: "Delete thumbnail", visibility: "unlisted" },
    {
      id: ambiguousVideoId,
      organizationId,
      title: "Ambiguous provider deletion thumbnail",
      providerAccountId,
      providerTenantSpaceId: providerSpaceId,
      providerAssetId: `private-step15-ambiguous-${marker}`,
    },
    { id: raceVideoId, organizationId, title: "Thumbnail lifecycle race" },
    {
      id: legacyVideoId, organizationId, title: "Preserved legacy thumbnail", visibility: "unlisted",
      thumbnailObjectKey: legacyKey, thumbnailContentType: "image/jpeg",
      thumbnailSizeBytes: 5, thumbnailVersion: legacyVersion,
      thumbnailMutableUntil: legacyMutableUntil,
    },
    { id: foreignVideoId, organizationId: foreignOrganizationId, title: "Foreign thumbnail" },
  ]);
  await tx.insert(thumbnailUploadIntentsTable).values({
    organizationId, videoId: legacyVideoId, objectKey: legacyKey,
    declaredContentType: "image/jpeg", declaredSizeBytes: 5, expiresAt: legacyMutableUntil,
  });
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function session(label: string, groupId: string) {
  const email = `step15-${label}-${marker}@example.test`;
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Step 15 ${label}`, email, password: `Step15-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  await db.insert(membershipsTable).values({ organizationId, userId: user!.id, groupId, status: "active" });
  return cookie;
}

const fullCookie = await session("full", fullGroupId);
const viewerCookie = await session("viewer", viewerGroupId);

async function api(path: string, method = "GET", body?: unknown, cookie = fullCookie) {
  return fetch(`${root}/api${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const signatures = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]),
  "image/png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
  "image/webp": Buffer.from("RIFF1234WEBPdata"),
};

async function intent(target: string, contentType = "image/jpeg", sizeBytes = signatures["image/jpeg"].length) {
  const response = await api(`/videos/${target}/thumbnail-upload-intent`, "POST", { contentType, sizeBytes });
  const json = await response.json() as {
    intentId: string;
    requiredHeaders: Record<string, string>;
    expiresAt: string;
  };
  return { response, json, key: storage.signedKey! };
}

async function finalize(target: string, intentId: string) {
  return api(`/videos/${target}/thumbnail-finalize`, "POST", { intentId });
}

storage.objects.set(legacyKey, { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), contentType: "image/jpeg" });
const legacyUrl = `/videos/${legacyVideoId}/thumbnail?v=${legacyVersion}`;
assert.equal((await api(legacyUrl)).status, 404, "legacy signed key stays hidden during capability horizon");
await cleanupThumbnailObjects(storage, new Date(legacyMutableUntil.getTime() + 1));
const [legacyIntent] = await db.select().from(thumbnailUploadIntentsTable)
  .where(eq(thumbnailUploadIntentsTable.objectKey, legacyKey)).limit(1);
assert(legacyIntent, "active legacy intent survives expiration cleanup");
const [legacyCleanup] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, legacyKey)).limit(1);
assert.equal(legacyCleanup, undefined, "active legacy object is never enqueued for cleanup");
await db.update(videosTable).set({ thumbnailMutableUntil: new Date(0) })
  .where(eq(videosTable.id, legacyVideoId));
assert.equal((await api(legacyUrl)).status, 200, "legacy thumbnail is accessible after safety horizon");

let previousFinalKey: string | undefined;
let previousUrl: string | undefined;
let latestUrl = "";
let latestCandidateKey = "";
for (const [contentType, bytes] of Object.entries(signatures)) {
  const created = await intent(videoId, contentType, bytes.length);
  assert.equal(created.response.status, 201);
  assert.equal(created.json.requiredHeaders["Content-Type"], contentType);
  const ttlMs = new Date(created.json.expiresAt).getTime() - Date.now();
  assert(ttlMs > 0 && ttlMs <= 5 * 60_000, "signed candidate TTL is at most five minutes");
  storage.objects.set(created.key, { bytes, contentType });
  latestCandidateKey = created.key;
  const finalized = await finalize(videoId, created.json.intentId);
  assert.equal(finalized.status, 200);
  const finalizedBody = await finalized.json() as { thumbnailUrl: string };
  const replay = await finalize(videoId, created.json.intentId);
  assert.equal(replay.status, 200, "finalize replay is idempotent");
  assert.equal((await replay.json() as { thumbnailUrl: string }).thumbnailUrl, finalizedBody.thumbnailUrl);
  latestUrl = finalizedBody.thumbnailUrl;
  const [persisted] = await db.select({
    objectKey: videosTable.thumbnailObjectKey,
    generation: videosTable.thumbnailGeneration,
  }).from(videosTable).where(eq(videosTable.id, videoId));
  assert(persisted?.objectKey && persisted.objectKey !== created.key, "signed candidate is never persisted");
  assert.equal(persisted.generation, "1", "promoted immutable generation is persisted");
  const [candidateCleanup] = await db.select().from(objectCleanupOutboxTable)
    .where(eq(objectCleanupOutboxTable.objectKey, created.key)).limit(1);
  assert(candidateCleanup, "promoted candidate is durably enqueued");
  if (previousFinalKey) {
    const [cleanup] = await db.select().from(objectCleanupOutboxTable)
      .where(eq(objectCleanupOutboxTable.objectKey, previousFinalKey)).limit(1);
    assert(cleanup, "replacement durably enqueues the prior key");
    assert.equal((await api(previousUrl!.replace(/^\/api/, ""))).status, 404, "old version URL is invalidated");
  }
  previousFinalKey = persisted.objectKey;
  previousUrl = finalizedBody.thumbnailUrl;
}

storage.objects.set(latestCandidateKey, {
  bytes: Buffer.from("overwritten signed candidate"),
  contentType: "image/webp",
  generation: "999",
});
const rlsClient = await pool.connect();
try {
  await rlsClient.query("begin");
  await rlsClient.query("set local role vid_app");
  await rlsClient.query("select set_config('app.organization_id',$1,true)", [organizationId]);
  const ownCleanup = await rlsClient.query(
    "select count(*)::int as count from object_cleanup_outbox where organization_id=$1",
    [organizationId],
  );
  assert(Number(ownCleanup.rows[0]?.count) > 0);
  const foreignCleanup = await rlsClient.query(
    "select count(*)::int as count from object_cleanup_outbox where organization_id=$1",
    [foreignOrganizationId],
  );
  assert.equal(Number(foreignCleanup.rows[0]?.count), 0);
  await assert.rejects(rlsClient.query(
    "insert into object_cleanup_outbox(organization_id,object_key) values($1,$2)",
    [foreignOrganizationId, `thumbnail-finals/${foreignOrganizationId}/${foreignVideoId}/${randomUUID()}`],
  ));
  await rlsClient.query("rollback");
} finally {
  rlsClient.release();
}
async function expectWorkerDenied(statement: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role vid_app");
    await client.query("set local role vid_worker");
    await assert.rejects(client.query(statement));
    await client.query("rollback");
  } finally {
    client.release();
  }
}
const workerClient = await pool.connect();
try {
  await workerClient.query("begin");
  await workerClient.query("set local role vid_app");
  await workerClient.query("set local role vid_worker");
  await workerClient.query("select id from object_cleanup_outbox limit 1");
  await workerClient.query("select id from thumbnail_upload_intents limit 1");
  await workerClient.query("select id from videos limit 1");
  await workerClient.query("rollback");
} finally {
  workerClient.release();
}
await expectWorkerDenied("select id from users limit 1");
await expectWorkerDenied("select id from sessions limit 1");
await expectWorkerDenied(`update videos set title=title where id='${videoId}'`);
let served = await api(latestUrl.replace(/^\/api/, ""));
assert.equal(served.status, 200);
assert.equal(served.headers.get("x-content-type-options"), "nosniff");
assert.match(served.headers.get("cache-control") ?? "", /max-age=31536000, immutable/);
assert.equal(await served.text(), signatures["image/webp"].toString());
assert.equal((await api(`/videos/${videoId}/thumbnail?v=${randomUUID()}`)).status, 404);
const versionQuery = new URL(latestUrl, root).search;
const publicServed = await fetch(`${root}/api/public/videos/${videoId}/thumbnail${versionQuery}`);
assert.equal(publicServed.status, 200);
assert.match(publicServed.headers.get("cache-control") ?? "", /public, max-age=31536000, immutable/);
assert.equal((await fetch(`${root}/api/public/videos/${privateVideoId}/thumbnail?v=${randomUUID()}`)).status, 404);
assert.equal((await intent(foreignVideoId)).response.status, 404);
assert.equal((await api(`/videos/${videoId}/thumbnail-upload-intent`, "POST", {
  contentType: "image/jpeg", sizeBytes: 5,
}, viewerCookie)).status, 403);

for (const scenario of ["bad-signature", "type-mismatch", "size-mismatch", "zero", "oversize", "expired", "missing"] as const) {
  const declaredType = scenario === "type-mismatch" ? "image/png" : "image/jpeg";
  const created = await intent(privateVideoId, declaredType, scenario === "size-mismatch" ? 6 : 5);
  if (scenario !== "missing") {
    storage.objects.set(created.key, {
      contentType: scenario === "type-mismatch" ? "image/jpeg" : declaredType,
      bytes: scenario === "bad-signature" ? Buffer.from("wrong")
        : scenario === "zero" ? Buffer.alloc(0)
          : scenario === "oversize" ? Buffer.alloc(10 * 1024 * 1024 + 1, 1)
            : signatures["image/jpeg"],
    });
  }
  if (scenario === "expired") {
    await db.update(thumbnailUploadIntentsTable).set({ expiresAt: new Date(0) })
      .where(eq(thumbnailUploadIntentsTable.id, created.json.intentId));
  }
  const response = await finalize(privateVideoId, created.json.intentId);
  assert([400, 409].includes(response.status), `${scenario} must be rejected`);
}

const generationRace = await intent(privateVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(generationRace.key, {
  bytes: signatures["image/jpeg"], contentType: "image/jpeg", generation: "10",
});
storage.mutateAfterRead = true;
assert.equal((await finalize(privateVideoId, generationRace.json.intentId)).status, 503);
const [notPromoted] = await db.select({ key: videosTable.thumbnailObjectKey })
  .from(videosTable).where(eq(videosTable.id, privateVideoId));
assert.equal(notPromoted?.key, null, "changed candidate generation is never persisted");

const copyFailure = await intent(privateVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(copyFailure.key, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
storage.failAfterCopy = true;
assert.equal((await finalize(privateVideoId, copyFailure.json.intentId)).status, 503);

const dbFailure = await intent(privateVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(dbFailure.key, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
app.locals.thumbnailFinalizeAfterCopy = async () => { throw new Error("deterministic post-copy DB failure"); };
assert.equal((await finalize(privateVideoId, dbFailure.json.intentId)).status, 503);
delete app.locals.thumbnailFinalizeAfterCopy;
const compensations = await db.select().from(objectCleanupOutboxTable).where(and(
  eq(objectCleanupOutboxTable.organizationId, organizationId),
  // Both failed promotions reserve final keys under this video's hierarchy.
  sql`${objectCleanupOutboxTable.objectKey} like ${`thumbnail-finals/${organizationId}/${privateVideoId}/%`}`,
));
assert(compensations.length >= 3, "copy/generation/transaction failures retain durable compensation");
await db.update(objectCleanupOutboxTable).set({ nextAttemptAt: new Date(0) }).where(and(
  eq(objectCleanupOutboxTable.organizationId, organizationId),
  sql`${objectCleanupOutboxTable.objectKey} like ${`thumbnail-finals/${organizationId}/${privateVideoId}/%`}`,
));
await cleanupThumbnailObjects(storage);
for (const compensation of compensations) {
  assert.equal(storage.objects.has(compensation.objectKey), false, "compensation cleans any copied final object");
}

assert.equal((await api(`/videos/${videoId}/thumbnail`, "DELETE")).status, 204);
assert.equal((await api(`/videos/${videoId}/thumbnail`)).status, 404);

const deleteCandidate = await intent(deleteVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(deleteCandidate.key, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
assert.equal((await finalize(deleteVideoId, deleteCandidate.json.intentId)).status, 200);
assert.equal((await api(`/videos/${deleteVideoId}`, "DELETE")).status, 204);
const [deleteOutbox] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, deleteCandidate.key)).limit(1);
assert(deleteOutbox, "video deletion enqueues its thumbnail");

const ambiguousCandidate = await intent(ambiguousVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(ambiguousCandidate.key, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
assert.equal((await finalize(ambiguousVideoId, ambiguousCandidate.json.intentId)).status, 200);
const [ambiguousBeforeDelete] = await db.select({ key: videosTable.thumbnailObjectKey })
  .from(videosTable).where(eq(videosTable.id, ambiguousVideoId));
assert(ambiguousBeforeDelete?.key);
const provider = videoProviders.resolve("step7-smoke") as unknown as {
  deleteAssetCalls: number;
  failNextDeleteAfterAcceptance: boolean;
};
provider.failNextDeleteAfterAcceptance = true;
assert.equal((await api(`/videos/${ambiguousVideoId}`, "DELETE")).status, 503);
const [ambiguousRow] = await db.select().from(videosTable).where(eq(videosTable.id, ambiguousVideoId));
assert.equal(ambiguousRow?.reconciliationRequired, "provider asset deletion outcome unknown");
const [prematureCleanup] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, ambiguousBeforeDelete.key)).limit(1);
assert.equal(prematureCleanup, undefined, "ambiguous provider deletion must not enqueue thumbnail cleanup");
assert.equal((await intent(ambiguousVideoId)).response.status, 409);
assert.equal((await finalize(ambiguousVideoId, ambiguousCandidate.json.intentId)).status, 409);
assert.equal((await api(`/videos/${ambiguousVideoId}/thumbnail`, "DELETE")).status, 409);
assert.equal((await api(`/videos/${ambiguousVideoId}`, "DELETE")).status, 409);

// Finalize holds the video lifecycle lock while inspecting storage. Deletion
// waits for it, then claims and outboxes the newly finalized object.
const raceCandidate = await intent(raceVideoId, "image/jpeg", signatures["image/jpeg"].length);
storage.objects.set(raceCandidate.key, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
const entered = new Promise<void>((resolve) => {
  storage.metadataEntered = resolve;
});
storage.blockMetadata = true;
const racingFinalize = finalize(raceVideoId, raceCandidate.json.intentId);
await entered;
const racingDelete = api(`/videos/${raceVideoId}`, "DELETE");
let deleteSettled = false;
void racingDelete.then(() => { deleteSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(deleteSettled, false, "deletion waits on the finalize lifecycle lock");
storage.releaseMetadata?.();
assert.equal((await racingFinalize).status, 200);
assert.equal((await racingDelete).status, 204);
const [raceCleanup] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, raceCandidate.key)).limit(1);
assert(raceCleanup, "serialized deletion outboxes the racing finalized candidate");

const retryKey = `thumbnail-finals/${organizationId}/${privateVideoId}/${randomUUID()}`;
storage.objects.set(retryKey, { bytes: signatures["image/jpeg"], contentType: "image/jpeg" });
await db.insert(objectCleanupOutboxTable).values({
  organizationId,
  objectKey: retryKey,
  nextAttemptAt: new Date(0),
});
storage.failDeleteKeys.add(retryKey);
assert.equal((await cleanupThumbnailObjects(storage)).failed, 1);
await db.update(objectCleanupOutboxTable).set({ nextAttemptAt: new Date(0) })
  .where(eq(objectCleanupOutboxTable.objectKey, retryKey));
assert.equal((await cleanupThumbnailObjects(storage)).completed >= 1, true);

const terminalKey = `thumbnails/${organizationId}/${privateVideoId}/${randomUUID()}`;
await db.insert(objectCleanupOutboxTable).values({
  organizationId,
  objectKey: terminalKey,
  attempts: MAX_THUMBNAIL_CLEANUP_ATTEMPTS - 1,
  nextAttemptAt: new Date(0),
});
storage.permanentFailDeleteKeys.add(terminalKey);
const terminalRun = await cleanupThumbnailObjects(storage);
assert.equal(terminalRun.quarantined, 1);
const [terminal] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, terminalKey)).limit(1);
assert(terminal?.quarantinedAt);
assert.equal(terminal.completedAt, null);
assert.equal(terminal.attempts, MAX_THUMBNAIL_CLEANUP_ATTEMPTS);
const callsAtQuarantine = storage.deleteAttempts.get(terminalKey);
await cleanupThumbnailObjects(storage, new Date(Date.now() + 24 * 60 * 60_000));
const [stillTerminal] = await db.select().from(objectCleanupOutboxTable)
  .where(eq(objectCleanupOutboxTable.objectKey, terminalKey)).limit(1);
assert.equal(stillTerminal?.attempts, MAX_THUMBNAIL_CLEANUP_ATTEMPTS);
assert.equal(storage.deleteAttempts.get(terminalKey), callsAtQuarantine, "quarantined cleanup is never claimed again");

console.log("Step 15 thumbnail smoke passed");
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
await db.delete(objectCleanupOutboxTable).where(eq(objectCleanupOutboxTable.organizationId, organizationId));
await db.delete(objectCleanupOutboxTable).where(eq(objectCleanupOutboxTable.organizationId, foreignOrganizationId));
await db.delete(organizationsTable).where(and(
  eq(organizationsTable.id, organizationId),
));
await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
await db.delete(plansTable).where(eq(plansTable.id, planId));
await pool.end();