import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ArchiveColdMasterInput, ColdMasterByteStream, ColdMasterStorage, RestoreColdMasterResult } from "./lib/cold-master-storage";
import type { ColdMasterTransfer, RestoreColdMasterTargetInput } from "./lib/cold-master-transfer";
import {
  ColdMasterIntegrityMismatchError, setRuntimeColdMasterStorageForTest,
} from "./lib/cold-master-storage";
import {
  ColdMasterTransferDefinitiveError, ColdMasterTransferTransientError, setRuntimeColdMasterTransferForTest,
} from "./lib/cold-master-transfer";

if (process.env.NODE_ENV !== "test") throw new Error("master-storage lifecycle smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const {
  accountsTable, auditLogsTable, db, groupPermissionsTable, membershipsTable,
  masterStorageOperationsTable, organizationsTable, permissionGroupsTable,
  permissionsTable, plansTable, providerAccountsTable, providerTenantSpacesTable,
  sessionsTable, usersTable, videosTable,
} = await import("@workspace/db");
const { default: app } = await import("./app");
const { dispatchMasterStorageOperations, processMasterStorageOperation } = await import("./lib/master-storage-operations");

const marker = randomUUID();
const planId = randomUUID(), orgA = randomUUID(), orgB = randomUUID();
const managerGroup = randomUUID(), viewerGroup = randomUUID(), otherGroup = randomUUID();
const accountId = randomUUID(), spaceA = randomUUID(), spaceB = randomUUID();
const videoA = randomUUID(), videoFailure = randomUUID(), videoB = randomUUID();
const videoRace = randomUUID(), videoCancellation = randomUUID(), videoInvalidSource = randomUUID();
const userIds: string[] = [];
const sourceBytes = Buffer.from(`master archive bytes ${marker}`);
const sha256 = createHash("sha256").update(sourceBytes).digest("hex");

const body = async function* (): ColdMasterByteStream {
  yield sourceBytes.subarray(0, 5); yield sourceBytes.subarray(5);
};
async function collect(input: ColdMasterByteStream) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
}
class MemoryStorage implements ColdMasterStorage {
  readonly availability = { kind: "available", configuration: "configured" } as const;
  readonly objects = new Map<string, { bytes: Buffer; contentType: string; sha256: string }>();
  metadataMismatch = false;
  stopAfterFirstChunk = false;
  archiveBarrier: { entered: () => void; wait: Promise<void> } | undefined;
  archives = 0;
  async archive(input: ArchiveColdMasterInput) {
    this.archives++;
    if (this.stopAfterFirstChunk) {
      this.stopAfterFirstChunk = false;
      const iterator = input.body[Symbol.asyncIterator]();
      await iterator.next();
      throw new Error("storage write interrupted");
    }
    const bytes = await collect(input.body);
    assert.deepEqual(bytes, sourceBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256);
    const existing = this.objects.get(input.storageKey);
    if (!existing) this.objects.set(input.storageKey, { bytes, contentType: input.contentType, sha256: input.sha256 });
    if (this.archiveBarrier) {
      const barrier = this.archiveBarrier;
      this.archiveBarrier = undefined;
      barrier.entered();
      await barrier.wait;
    }
    if (this.metadataMismatch) {
      this.metadataMismatch = false;
      return { storageKey: input.storageKey, size: bytes.length + 1, contentType: input.contentType, sha256: input.sha256 };
    }
    return { storageKey: input.storageKey, size: bytes.length, contentType: input.contentType, sha256: input.sha256 };
  }
  async restore(storageKey: string): Promise<RestoreColdMasterResult> {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error("fixture object missing");
    return { storageKey, size: object.bytes.length, contentType: object.contentType, sha256: object.sha256, body: body() };
  }
}
class MemoryTransfer implements ColdMasterTransfer {
  readonly availability = { kind: "available", configuration: "configured" } as const;
  archiveCalls = 0;
  restoreCalls = 0;
  transient = 0;
  definitive = false;
  invalidSourceMetadata = false;
  ambiguousRestore = false;
  wrongRestoreTarget = false;
  sourceClosed = false;
  cancelAwareSource = false;
  readonly restored = new Map<string, Buffer>();
  async openSource(snapshot: RestoreColdMasterTargetInput["target"]) {
    this.archiveCalls++;
    if (this.transient-- > 0) throw new ColdMasterTransferTransientError();
    if (this.definitive) throw new ColdMasterTransferDefinitiveError("source_not_found");
    const sourceBody = this.cancelAwareSource
      ? (async function* (owner: MemoryTransfer): ColdMasterByteStream {
        try {
          yield sourceBytes.subarray(0, 5);
          yield sourceBytes.subarray(5);
        } finally {
          owner.sourceClosed = true;
        }
      })(this)
      : body();
    return {
      source: snapshot,
      contentLength: this.invalidSourceMetadata ? sourceBytes.length + 1 : sourceBytes.length,
      contentType: "video/mp4",
      sha256,
      body: sourceBody,
    };
  }
  async restoreToTarget(input: RestoreColdMasterTargetInput) {
    this.restoreCalls++;
    const bytes = await collect(input.body);
    assert.equal(input.contentLength, sourceBytes.length);
    assert.equal(input.contentType, "video/mp4");
    assert.equal(input.sha256, sha256);
    const old = this.restored.get(input.idempotencyKey);
    if (old) { assert.deepEqual(old, bytes); return { target: input.target, idempotencyKey: input.idempotencyKey, contentLength: input.contentLength, contentType: input.contentType, sha256: input.sha256 }; }
    this.restored.set(input.idempotencyKey, bytes);
    if (this.ambiguousRestore) throw new Error("provider accepted bytes but response was lost");
    const target = this.wrongRestoreTarget
      ? { ...input.target, providerAssetId: `${input.target.providerAssetId}-wrong` }
      : input.target;
    return { target, idempotencyKey: input.idempotencyKey, contentLength: input.contentLength, contentType: input.contentType, sha256: input.sha256 };
  }
}

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const address = server.address(); assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;
const request = (path: string, init: RequestInit = {}, cookie?: string) => fetch(`${root}${path}`, {
  ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
});
async function createUser(label: string, organizationId: string, groupId: string) {
  const email = `master-${label}-${marker}@example.test`;
  const response = await request("/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Master ${label}`, email, password: `Master-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)); assert(user);
  userIds.push(user.id);
  await db.insert(membershipsTable).values({ organizationId, userId: user.id, groupId, status: "active" });
  return { cookie, id: user.id };
}
const archivePath = (id: string) => `/api/videos/${id}/master-archive`;
const restorePath = (id: string) => `/api/videos/${id}/master-restore`;

try {
  await db.insert(plansTable).values({ id: planId, code: `master-${marker}`, name: "Master smoke", storageLimitGb: 10 });
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Master A", slug: `master-a-${marker}`, status: "active", planId },
    { id: orgB, name: "Master B", slug: `master-b-${marker}`, status: "active", planId },
  ]);
  await db.insert(permissionGroupsTable).values([
    { id: managerGroup, organizationId: orgA, name: "Managers", description: "smoke" },
    { id: viewerGroup, organizationId: orgA, name: "Viewers", description: "smoke" },
    { id: otherGroup, organizationId: orgB, name: "Managers", description: "smoke" },
  ]);
  await db.insert(permissionsTable).values([
    { key: "videos.read", description: "read" }, { key: "videos.update", description: "update" },
    { key: "videos.delete", description: "delete" },
  ]).onConflictDoNothing();
  await db.insert(groupPermissionsTable).values([
    { groupId: managerGroup, permissionKey: "videos.read" }, { groupId: managerGroup, permissionKey: "videos.update" },
    { groupId: managerGroup, permissionKey: "videos.delete" },
    { groupId: viewerGroup, permissionKey: "videos.read" }, { groupId: otherGroup, permissionKey: "videos.read" }, { groupId: otherGroup, permissionKey: "videos.update" },
  ]);
  await db.insert(providerAccountsTable).values({ id: accountId, providerKey: "step7-smoke", label: `private-${marker}`, encryptedCredentials: `private-${marker}`, maxZones: 2 });
  await db.insert(providerTenantSpacesTable).values([
    { id: spaceA, organizationId: orgA, providerAccountId: accountId, providerSpaceId: `space-a-${marker}`, idempotencyKey: `a-${marker}`, state: "created" },
    { id: spaceB, organizationId: orgB, providerAccountId: accountId, providerSpaceId: `space-b-${marker}`, idempotencyKey: `b-${marker}`, state: "created" },
  ]);
  await db.insert(videosTable).values([
    { id: videoA, organizationId: orgA, title: "Archive success", status: "ready", uploadSourceBytes: sourceBytes.length, uploadSourceContentType: "video/mp4", providerAccountId: accountId, providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `asset-a-${marker}` },
    { id: videoFailure, organizationId: orgA, title: "Archive failure", status: "processing", uploadSourceBytes: sourceBytes.length, uploadSourceContentType: "video/mp4", providerAccountId: accountId, providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `asset-f-${marker}` },
    { id: videoB, organizationId: orgB, title: "Foreign", providerAccountId: accountId, providerTenantSpaceId: `space-b-${marker}`, providerAssetId: `asset-b-${marker}` },
    { id: videoRace, organizationId: orgA, title: "Archive relink race", status: "ready", uploadSourceBytes: sourceBytes.length, uploadSourceContentType: "video/mp4", providerAccountId: accountId, providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `asset-race-${marker}` },
    { id: videoCancellation, organizationId: orgA, title: "Archive cancellation", status: "ready", uploadSourceBytes: sourceBytes.length, uploadSourceContentType: "video/mp4", providerAccountId: accountId, providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `asset-cancel-${marker}` },
    { id: videoInvalidSource, organizationId: orgA, title: "Invalid archive source", status: "ready", uploadSourceBytes: sourceBytes.length, uploadSourceContentType: "video/mp4", providerAccountId: accountId, providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `asset-invalid-${marker}` },
  ]);
  const manager = await createUser("manager", orgA, managerGroup);
  const viewer = await createUser("viewer", orgA, viewerGroup);

  assert.equal((await request(`/api/videos/${videoA}/master-status`)).status, 401);
  assert.equal((await request(`/api/videos/${videoA}/master-status`, {}, viewer.cookie)).status, 200);
  assert.equal((await request(archivePath(videoA), { method: "POST" }, viewer.cookie)).status, 403);
  assert.equal((await request(`/api/videos/${videoB}/master-status`, {}, manager.cookie)).status, 404);
  const unavailable = await request(archivePath(videoA), { method: "POST" }, manager.cookie);
  assert.equal(unavailable.status, 503);
  assert.equal((await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoA))).length, 0);
  assert.equal((await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_requested")))).length, 0);

  const storage = new MemoryStorage(), transfer = new MemoryTransfer();
  setRuntimeColdMasterStorageForTest(storage); setRuntimeColdMasterTransferForTest(transfer);
  const nonReady = await request(archivePath(videoFailure), { method: "POST" }, manager.cookie);
  assert.equal(nonReady.status, 409);
  assert.equal((await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoFailure))).length, 0);
  assert.equal((await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_requested")))).length, 0);
  await db.update(videosTable).set({ status: "ready" }).where(eq(videosTable.id, videoFailure));
  const status = await request(`/api/videos/${videoA}/master-status`, {}, manager.cookie);
  assert.equal(status.status, 200);
  const statusText = await status.text();
  for (const privateValue of [`space-a-${marker}`, `asset-a-${marker}`, accountId, "storageKey", "provider", "sha256"]) assert(!statusText.includes(privateValue));
  const responses = await Promise.all(Array.from({ length: 3 }, () => request(archivePath(videoA), { method: "POST" }, manager.cookie)));
  assert.deepEqual(responses.map((r) => r.status), [202, 202, 202]);
  const [archive] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoA)); assert(archive);
  assert.equal((await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_requested")))).length, 1);
  assert.equal(
    (await request(`/api/videos/${videoA}`, { method: "DELETE" }, manager.cookie)).status,
    409,
    "video deletion is fenced while master work is outstanding",
  );

  let enqueueFails = true;
  assert.equal((await dispatchMasterStorageOperations(async () => { if (enqueueFails) throw new Error("no queue"); })).dispatched, 0);
  let [pending] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, archive.id));
  assert.equal(pending?.state, "failed"); assert.equal(pending?.diagnosticCode, "enqueue_failed"); assert.equal(pending?.attempts, 0);
  await db.update(masterStorageOperationsTable).set({ retryAfterAt: new Date(0) }).where(eq(masterStorageOperationsTable.id, archive.id));
  const sent: Array<{ operationId: string; generation: number }> = [];
  assert.equal((await dispatchMasterStorageOperations(async (job) => { sent.push(job); })).dispatched, 1);
  assert.equal(sent[0]!.operationId, archive.id); assert.equal(sent[0]!.generation, 2);
  const workers = await Promise.all([processMasterStorageOperation(archive.id, undefined, undefined, 2), processMasterStorageOperation(archive.id, undefined, undefined, 2)]);
  assert.equal(workers.filter((x) => "completed" in x).length, 1);
  assert.equal(transfer.archiveCalls, 1); assert.equal(storage.archives, 1);
  const [completed] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, archive.id));
  assert.equal(completed?.state, "completed"); assert.deepEqual(completed?.resultMetadata, { storageKey: `v1/${orgA}/${videoA}/${sha256}`, size: sourceBytes.length, contentType: "video/mp4", sha256 });
  const [archivedVideo] = await db.select().from(videosTable).where(eq(videosTable.id, videoA));
  assert.equal(archivedVideo?.masterStorageKey, `v1/${orgA}/${videoA}/${sha256}`); assert(archivedVideo?.masterArchivedAt);
  assert.equal((await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_completed")))).length, 1);

  // Relinking the provider identity while bytes are in flight cannot attach a stale archive.
  assert.equal((await request(archivePath(videoRace), { method: "POST" }, manager.cookie)).status, 202);
  const raceJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { raceJobs.push(job); });
  let barrierEntered!: () => void;
  let releaseBarrier!: () => void;
  const entered = new Promise<void>((resolve) => { barrierEntered = resolve; });
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  storage.archiveBarrier = { entered: barrierEntered, wait: barrier };
  const racingWorker = processMasterStorageOperation(raceJobs[0]!.operationId, undefined, undefined, raceJobs[0]!.generation);
  await entered;
  await db.update(videosTable).set({ providerAssetId: `asset-race-relinked-${marker}` }).where(eq(videosTable.id, videoRace));
  releaseBarrier();
  const raceOutcome = await racingWorker;
  assert("reconciliationRequired" in raceOutcome);
  const [raceOperation] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoRace));
  const [raceVideo] = await db.select().from(videosTable).where(eq(videosTable.id, videoRace));
  assert.equal(raceOperation?.state, "reconciliation_required");
  assert.equal(raceOperation?.diagnosticCode, "video_snapshot_changed");
  assert.equal(raceVideo?.masterStorageKey, null);

  // A storage consumer that stops early causes the provider source iterator to close.
  transfer.cancelAwareSource = true;
  transfer.sourceClosed = false;
  storage.stopAfterFirstChunk = true;
  assert.equal((await request(archivePath(videoCancellation), { method: "POST" }, manager.cookie)).status, 202);
  const cancellationJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { cancellationJobs.push(job); });
  await processMasterStorageOperation(cancellationJobs[0]!.operationId, undefined, undefined, cancellationJobs[0]!.generation);
  assert.equal(transfer.sourceClosed, true);
  transfer.cancelAwareSource = false;
  const [cancelledArchive] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoCancellation));
  assert.equal(cancelledArchive?.state, "failed");
  assert.equal(cancelledArchive?.retryable, true, "content-addressed archive writes are safe to retry");

  // Declared provider metadata must match the immutable upload snapshot.
  transfer.invalidSourceMetadata = true;
  assert.equal((await request(archivePath(videoInvalidSource), { method: "POST" }, manager.cookie)).status, 202);
  const invalidSourceJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { invalidSourceJobs.push(job); });
  await processMasterStorageOperation(invalidSourceJobs[0]!.operationId, undefined, undefined, invalidSourceJobs[0]!.generation);
  transfer.invalidSourceMetadata = false;
  const [invalidSource] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoInvalidSource));
  assert.equal(invalidSource?.state, "failed");
  assert.equal(invalidSource?.retryable, false);
  assert.equal(invalidSource?.diagnosticCode, "transfer_rejected");

  const restoreResponses = await Promise.all([request(restorePath(videoA), { method: "POST" }, manager.cookie), request(restorePath(videoA), { method: "POST" }, manager.cookie)]);
  assert.deepEqual(restoreResponses.map((r) => r.status), [202, 202]);
  const [restore] = await db.select().from(masterStorageOperationsTable).where(and(eq(masterStorageOperationsTable.videoId, videoA), eq(masterStorageOperationsTable.operation, "restore"))); assert(restore);
  const restoreJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { restoreJobs.push(job); });
  await Promise.all([processMasterStorageOperation(restore.id, undefined, undefined, restoreJobs[0]!.generation), processMasterStorageOperation(restore.id, undefined, undefined, restoreJobs[0]!.generation)]);
  assert.equal(transfer.restoreCalls, 1); assert.deepEqual(transfer.restored.get(restore.idempotencyKey), sourceBytes);

  // A provider write accepted without durable evidence is never retried automatically.
  await db.update(videosTable).set({ providerAssetId: `asset-a-replacement-${marker}` }).where(eq(videosTable.id, videoA));
  transfer.ambiguousRestore = true;
  assert.equal((await request(restorePath(videoA), { method: "POST" }, manager.cookie)).status, 202);
  const ambiguousJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { ambiguousJobs.push(job); });
  const ambiguousOutcome = await processMasterStorageOperation(ambiguousJobs[0]!.operationId, undefined, undefined, ambiguousJobs[0]!.generation);
  transfer.ambiguousRestore = false;
  assert("reconciliationRequired" in ambiguousOutcome);
  const [ambiguousRestore] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, ambiguousJobs[0]!.operationId));
  assert.equal(ambiguousRestore?.state, "reconciliation_required");
  assert.equal(ambiguousRestore?.diagnosticCode, "transfer_ambiguous");
  assert.equal(ambiguousRestore?.retryable, false);

  // Attestation for a different provider target is also reconciliation-required.
  await db.update(videosTable).set({ providerAssetId: `asset-a-third-${marker}` }).where(eq(videosTable.id, videoA));
  transfer.wrongRestoreTarget = true;
  assert.equal((await request(restorePath(videoA), { method: "POST" }, manager.cookie)).status, 202);
  const wrongTargetJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { wrongTargetJobs.push(job); });
  await processMasterStorageOperation(wrongTargetJobs[0]!.operationId, undefined, undefined, wrongTargetJobs[0]!.generation);
  transfer.wrongRestoreTarget = false;
  const [wrongTarget] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, wrongTargetJobs[0]!.operationId));
  assert.equal(wrongTarget?.state, "reconciliation_required");
  assert.equal(wrongTarget?.diagnosticCode, "transfer_ambiguous");

  storage.metadataMismatch = true;
  const failureResponse = await request(archivePath(videoFailure), { method: "POST" }, manager.cookie); assert.equal(failureResponse.status, 202);
  const failureJobs: Array<{ operationId: string; generation: number }> = [];
  await dispatchMasterStorageOperations(async (job) => { failureJobs.push(job); });
  await processMasterStorageOperation(failureJobs[0]!.operationId, undefined, undefined, failureJobs[0]!.generation);
  const [failure] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.videoId, videoFailure));
  const [unarchived] = await db.select().from(videosTable).where(eq(videosTable.id, videoFailure));
  assert.equal(failure?.state, "failed"); assert.equal(failure?.diagnosticCode, "integrity_mismatch"); assert.equal(unarchived?.masterStorageKey, null); assert.equal(unarchived?.masterArchivedAt, null);

  // Retry noise, attempt-cap terminalization, and stale durable repair are all DB-backed.
  await db.update(masterStorageOperationsTable).set({
    state: "failed",
    attempts: 7,
    retryable: true,
    retryAfterAt: new Date(0),
    completedAt: null,
  }).where(eq(masterStorageOperationsTable.id, failure!.id));
  transfer.transient = 1;
  await dispatchMasterStorageOperations(async () => undefined);
  let [retry] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, failure!.id));
  await processMasterStorageOperation(retry!.id);
  [retry] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, failure!.id));
  assert.equal(retry?.attempts, 8); assert.equal(retry?.retryable, false); assert(retry?.completedAt);
  let terminalAudits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_failed")));
  assert.equal(terminalAudits.length, 2, "one final audit for each distinct terminal operation");
  await dispatchMasterStorageOperations(async () => undefined);
  terminalAudits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.archive_failed")));
  assert.equal(terminalAudits.length, 2, "attempt-8 terminalization is audited exactly once");
  await db.update(masterStorageOperationsTable).set({
    state: "queued",
    dispatchedAt: new Date(Date.now() - 11 * 60_000),
    retryable: true,
    completedAt: null,
    claimToken: null,
    claimedAt: null,
  }).where(eq(masterStorageOperationsTable.id, restore.id));
  await dispatchMasterStorageOperations(async () => undefined);
  const [staleQueued] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, restore.id));
  assert(staleQueued!.dispatchGeneration > restore.dispatchGeneration);
  await db.update(masterStorageOperationsTable).set({
    state: "processing", attempts: 1, retryable: true, claimToken: randomUUID(), claimedAt: new Date(Date.now() - 11 * 60_000),
  }).where(eq(masterStorageOperationsTable.id, restore.id));
  await dispatchMasterStorageOperations(async () => undefined);
  let [staleProcessing] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, restore.id));
  assert.equal(staleProcessing?.state, "processing", "an active claim inside the queue expiry cannot be redispatched");
  await db.update(masterStorageOperationsTable).set({
    claimedAt: new Date(Date.now() - 36 * 60_000),
  }).where(eq(masterStorageOperationsTable.id, restore.id));
  await dispatchMasterStorageOperations(async () => undefined);
  [staleProcessing] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, restore.id));
  assert.notEqual(staleProcessing?.state, "reconciliation_required");
  await db.update(masterStorageOperationsTable).set({
    state: "processing", attempts: 8, retryable: true, claimToken: randomUUID(), claimedAt: new Date(Date.now() - 36 * 60_000),
  }).where(eq(masterStorageOperationsTable.id, restore.id));
  await dispatchMasterStorageOperations(async () => undefined);
  [staleProcessing] = await db.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.id, restore.id));
  assert.equal(staleProcessing?.state, "reconciliation_required"); assert.equal(staleProcessing?.retryable, false); assert(staleProcessing?.completedAt);
  const restoreTerminal = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.restore_failed")));
  assert.equal(restoreTerminal.length, 1);
  await dispatchMasterStorageOperations(async () => undefined);
  assert.equal((await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "master_storage.restore_failed")))).length, 1);

  await assert.rejects(
    () => db.update(masterStorageOperationsTable).set({ retryable: true }).where(eq(masterStorageOperationsTable.id, archive.id)),
    (error: unknown) => {
      let current = error;
      while (current && typeof current === "object") {
        if ("code" in current && (current as { code?: string }).code === "23514") return true;
        current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
      }
      return false;
    },
  );
  await db.insert(masterStorageOperationsTable).values({
    organizationId: orgA,
    videoId: videoRace,
    requestedByUserId: manager.id,
    operation: "archive",
    state: "failed",
    retryable: true,
    idempotencyKey: createHash("sha256").update(`outstanding-a-${marker}`).digest("hex"),
    providerAccountId: accountId,
    providerTenantSpaceId: `space-a-${marker}`,
    providerAssetId: `outstanding-a-${marker}`,
  });
  await assert.rejects(
    () => db.insert(masterStorageOperationsTable).values({
      organizationId: orgA,
      videoId: videoRace,
      requestedByUserId: manager.id,
      operation: "archive",
      state: "failed",
      retryable: true,
      idempotencyKey: createHash("sha256").update(`outstanding-b-${marker}`).digest("hex"),
      providerAccountId: accountId,
      providerTenantSpaceId: `space-a-${marker}`,
      providerAssetId: `outstanding-b-${marker}`,
    }),
    (error: unknown) => {
      let current = error;
      while (current && typeof current === "object") {
        if ("code" in current && (current as { code?: string }).code === "23505") return true;
        current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
      }
      return false;
    },
  );

  const rls = await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app")); await tx.execute(sql`select set_config('app.organization_id', ${orgA}, true)`);
    return tx.select({ organizationId: masterStorageOperationsTable.organizationId }).from(masterStorageOperationsTable);
  });
  assert(rls.every((row) => row.organizationId === orgA));
  await assert.rejects(() => db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.master_storage_worker', 'on', true)`);
    await tx.insert(masterStorageOperationsTable).values({
      organizationId: orgA, videoId: videoB, requestedByUserId: manager.id, operation: "archive",
      idempotencyKey: `cross-tenant-${marker}`, providerAccountId: accountId,
      providerTenantSpaceId: `space-a-${marker}`, providerAssetId: `cross-${marker}`,
    });
  }), (error: unknown) => {
    let current = error;
    while (current && typeof current === "object") {
      if ("code" in current && (current as { code?: string }).code === "23503") return true;
      current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return false;
  });
  const allPrivate = JSON.stringify(await db.select().from(auditLogsTable).where(eq(auditLogsTable.organizationId, orgA)));
  for (const privateValue of [accountId, `space-a-${marker}`, `asset-a-${marker}`, sha256, `v1/${orgA}`]) assert(!allPrivate.includes(privateValue));
  console.log("Master-storage HTTP + DB lifecycle smoke passed");
} finally {
  setRuntimeColdMasterStorageForTest(); setRuntimeColdMasterTransferForTest();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(auditLogsTable).where(inArray(auditLogsTable.organizationId, [orgA, orgB]));
  await db.delete(masterStorageOperationsTable).where(inArray(masterStorageOperationsTable.videoId, [
    videoA, videoFailure, videoB, videoRace, videoCancellation, videoInvalidSource,
  ]));
  await db.delete(videosTable).where(inArray(videosTable.id, [
    videoA, videoFailure, videoB, videoRace, videoCancellation, videoInvalidSource,
  ]));
  await db.delete(providerTenantSpacesTable).where(inArray(providerTenantSpacesTable.id, [spaceA, spaceB]));
  await db.delete(membershipsTable).where(inArray(membershipsTable.organizationId, [orgA, orgB]));
  if (userIds.length) { await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds)); await db.delete(accountsTable).where(inArray(accountsTable.userId, userIds)); await db.delete(usersTable).where(inArray(usersTable.id, userIds)); }
  await db.delete(permissionGroupsTable).where(inArray(permissionGroupsTable.id, [managerGroup, viewerGroup, otherGroup]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
}