import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { masterStorageOperationsTable, videosTable } from "@workspace/db";
import { auditJob, auditUser, writeAuditEvent } from "./audit";
import type { TenantTransaction } from "./tenant-db";
import { createColdMasterObjectKey, getRuntimeColdMasterStorage, type ColdMasterStorage, ColdMasterDefinitiveWriteRejectionError, ColdMasterIntegrityMismatchError, ColdMasterObjectNotFoundError, ColdMasterStorageUnavailableError } from "./cold-master-storage";
import { getRuntimeColdMasterTransfer, type ColdMasterProviderAssetSnapshot, type ColdMasterTransfer, ColdMasterTransferAmbiguousError, ColdMasterTransferDefinitiveError, ColdMasterTransferTransientError, ColdMasterTransferUnavailableError } from "./cold-master-transfer";
import { withWorkerDb } from "./worker-db";

const maxAttempts = 8;
// Operation jobs expire after 30 minutes. A processing claim must not be
// declared stale while pg-boss can still be running the owning worker.
const processingLeaseMs = 35 * 60_000;
const activeStates = ["pending", "dispatching", "queued", "processing"] as const;
type Operation = "archive" | "restore";
export class MasterStorageNotFoundError extends Error {}
export class MasterStorageConflictError extends Error {
  readonly code = "MASTER_STORAGE_CONFLICT";
  constructor(readonly reason: "video_not_ready" | "provider_asset_missing" | "already_archived" | "master_not_verified" | "previous_operation_terminal" | "operation_in_progress") {
    super(reason);
  }
}
export class MasterStorageUnavailableError extends Error {
  readonly code = "MASTER_STORAGE_UNAVAILABLE";
}

function trackedStream(source: AsyncIterable<Uint8Array>, expectedSize: number) {
  const hash = createHash("sha256");
  const iterator = source[Symbol.asyncIterator]();
  let bytes = 0, ended = false, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await iterator.return?.();
    } catch {
      // Cleanup must not replace the integrity/provider error that stopped I/O.
    }
  };
  const body = (async function* () {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) {
          throw new ColdMasterIntegrityMismatchError("");
        }
        bytes += chunk.byteLength;
        if (bytes > expectedSize) throw new ColdMasterIntegrityMismatchError("");
        hash.update(chunk);
        yield chunk;
      }
      ended = true;
    } finally {
      if (!ended) await close();
    }
  })();
  return {
    body,
    close,
    verify(expectedSize: number, expectedSha256: string) {
      if (!ended || bytes !== expectedSize || hash.digest("hex") !== expectedSha256) {
        throw new ColdMasterIntegrityMismatchError("");
      }
    },
  };
}

function verifiedArchive(video: Pick<typeof videosTable.$inferSelect, "masterStorageKey" | "masterArchivedAt" | "masterSha256" | "masterSizeBytes" | "masterContentType">) {
  return Boolean(
    video.masterStorageKey
    && video.masterArchivedAt
    && typeof video.masterSha256 === "string"
    && /^[a-f0-9]{64}$/.test(video.masterSha256)
    && Number.isSafeInteger(video.masterSizeBytes)
    && (video.masterSizeBytes ?? 0) > 0
    && validContentType(video.masterContentType),
  );
}

function idem(input: {
  organizationId: string;
  videoId: string;
  operation: Operation;
  providerAccountId: string;
  providerTenantSpaceId: string;
  providerAssetId: string;
  storageKey?: string;
}) {
  return createHash("sha256").update([
    input.organizationId,
    input.videoId,
    input.operation,
    input.providerAccountId,
    input.providerTenantSpaceId,
    input.providerAssetId,
    input.storageKey ?? "",
  ].join("\0")).digest("hex");
}

function validContentType(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameProviderSnapshot(
  actual: ColdMasterProviderAssetSnapshot,
  expected: ColdMasterProviderAssetSnapshot,
) {
  return actual.providerAccountId === expected.providerAccountId
    && actual.providerTenantSpaceId === expected.providerTenantSpaceId
    && actual.providerAssetId === expected.providerAssetId;
}

function operationIsOutstanding(row: typeof masterStorageOperationsTable.$inferSelect) {
  return (activeStates as readonly string[]).includes(row.state)
    || (row.state === "failed" && row.retryable);
}
export function masterStorageConfigured(storage: ColdMasterStorage = getRuntimeColdMasterStorage(), transfer: ColdMasterTransfer = getRuntimeColdMasterTransfer()) {
  return { storageConfigured: storage.availability.kind === "available", sourceTransferConfigured: transfer.availability.kind === "available" };
}
export function publicMasterOperation(row?: typeof masterStorageOperationsTable.$inferSelect) {
  return row ? { operation: row.operation, state: row.state, diagnosticCode: row.diagnosticCode, retryable: row.retryable, createdAt: row.createdAt, updatedAt: row.updatedAt, completedAt: row.completedAt } : null;
}

export async function masterStatus(tx: TenantTransaction, organizationId: string, videoId: string, adapters = masterStorageConfigured()) {
  const [video] = await tx.select({ masterArchivedAt: videosTable.masterArchivedAt, masterStorageKey: videosTable.masterStorageKey, masterSha256: videosTable.masterSha256, masterSizeBytes: videosTable.masterSizeBytes, masterContentType: videosTable.masterContentType }).from(videosTable)
    .where(and(eq(videosTable.id, videoId), eq(videosTable.organizationId, organizationId))).limit(1);
  if (!video) throw new MasterStorageNotFoundError();
  const [latestArchive] = await tx.select().from(masterStorageOperationsTable).where(and(
    eq(masterStorageOperationsTable.organizationId, organizationId),
    eq(masterStorageOperationsTable.videoId, videoId),
    eq(masterStorageOperationsTable.operation, "archive"),
  )).orderBy(desc(masterStorageOperationsTable.createdAt), desc(masterStorageOperationsTable.id)).limit(1);
  const [latestRestore] = await tx.select().from(masterStorageOperationsTable).where(and(
    eq(masterStorageOperationsTable.organizationId, organizationId),
    eq(masterStorageOperationsTable.videoId, videoId),
    eq(masterStorageOperationsTable.operation, "restore"),
  )).orderBy(desc(masterStorageOperationsTable.createdAt), desc(masterStorageOperationsTable.id)).limit(1);
  return { ...adapters, hasArchivedMaster: verifiedArchive(video), archivedAt: verifiedArchive(video) ? video.masterArchivedAt : null,
    latestArchiveOperation: publicMasterOperation(latestArchive),
    latestRestoreOperation: publicMasterOperation(latestRestore) };
}

export async function requestMasterOperation(tx: TenantTransaction, input: {
  organizationId: string; userId: string; videoId: string; operation: Operation; requestId?: string;
  storage?: ColdMasterStorage; transfer?: ColdMasterTransfer;
}) {
  const storage = input.storage ?? getRuntimeColdMasterStorage(), transfer = input.transfer ?? getRuntimeColdMasterTransfer();
  if (storage.availability.kind !== "available" || transfer.availability.kind !== "available") throw new MasterStorageUnavailableError();
  const [video] = await tx.select().from(videosTable).where(and(
    eq(videosTable.id, input.videoId),
    eq(videosTable.organizationId, input.organizationId),
  )).for("update").limit(1);
  if (!video) throw new MasterStorageNotFoundError();
  if (video.deletionClaim || video.assetCreationClaim || video.reconciliationRequired) {
    throw new MasterStorageConflictError("operation_in_progress");
  }
  if (input.operation === "archive" && video.status !== "ready") throw new MasterStorageConflictError("video_not_ready");
  if (!video.providerAccountId || !video.providerTenantSpaceId || !video.providerAssetId) throw new MasterStorageConflictError("provider_asset_missing");
  if (input.operation === "archive" && video.masterStorageKey) {
    const [done] = await tx.select().from(masterStorageOperationsTable).where(and(eq(masterStorageOperationsTable.videoId, video.id), eq(masterStorageOperationsTable.operation, "archive"), eq(masterStorageOperationsTable.state, "completed"))).limit(1);
    if (done) return done;
    throw new MasterStorageConflictError("already_archived");
  }
  if (input.operation === "restore" && !verifiedArchive(video)) throw new MasterStorageConflictError("master_not_verified");
  const key = idem({
    organizationId: input.organizationId,
    videoId: video.id,
    operation: input.operation,
    providerAccountId: video.providerAccountId,
    providerTenantSpaceId: video.providerTenantSpaceId,
    providerAssetId: video.providerAssetId,
    storageKey: input.operation === "restore" ? video.masterStorageKey! : undefined,
  });
  const [existing] = await tx.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.idempotencyKey, key)).limit(1);
  if (existing) {
    if (operationIsOutstanding(existing) || existing.state === "completed") return existing;
    throw new MasterStorageConflictError("previous_operation_terminal");
  }
  const [outstanding] = await tx.select().from(masterStorageOperationsTable).where(and(
    eq(masterStorageOperationsTable.videoId, video.id),
    or(
      inArray(masterStorageOperationsTable.state, activeStates),
      and(eq(masterStorageOperationsTable.state, "failed"), eq(masterStorageOperationsTable.retryable, true)),
    ),
  )).orderBy(desc(masterStorageOperationsTable.createdAt)).limit(1);
  if (outstanding) throw new MasterStorageConflictError("operation_in_progress");
  const [created] = await tx.insert(masterStorageOperationsTable).values({
    organizationId: input.organizationId, videoId: video.id, requestedByUserId: input.userId, operation: input.operation,
    idempotencyKey: key, providerAccountId: video.providerAccountId, providerTenantSpaceId: video.providerTenantSpaceId,
    providerAssetId: video.providerAssetId, restoreStorageKey: input.operation === "restore" ? video.masterStorageKey! : null,
    restoreSha256: input.operation === "restore" ? video.masterSha256! : null,
    restoreSizeBytes: input.operation === "restore" ? video.masterSizeBytes! : null,
    restoreContentType: input.operation === "restore" ? video.masterContentType! : null,
  }).onConflictDoNothing().returning();
  if (!created) {
    // No exception is caught here: PostgreSQL otherwise marks this transaction aborted.
    const [raced] = await tx.select().from(masterStorageOperationsTable).where(eq(masterStorageOperationsTable.idempotencyKey, key)).limit(1);
    if (raced && (operationIsOutstanding(raced) || raced.state === "completed")) return raced;
    throw new MasterStorageConflictError("operation_in_progress");
  }
  await writeAuditEvent(tx, { organizationId: input.organizationId, actor: auditUser(input.userId), action: `master_storage.${input.operation}_requested`, category: "content", subject: { type: "video", id: video.id, label: video.title }, afterState: { operation: input.operation, state: "pending" }, requestId: input.requestId });
  return created;
}

async function workerTransaction<T>(work: (tx: TenantTransaction) => Promise<T>) {
  return withWorkerDb("master_storage", work);
}
export async function dispatchMasterStorageOperations(enqueue: (job: { operationId: string; generation: number }) => Promise<unknown>) {
  const staleQueuedAt = new Date(Date.now() - 10 * 60_000);
  const staleProcessingAt = new Date(Date.now() - processingLeaseMs);
  await workerTransaction(async (tx) => {
    // A queued pg-boss job can expire without ever claiming the operation.
    await tx.update(masterStorageOperationsTable).set({ state: "pending", claimToken: null, claimedAt: null, diagnosticCode: "queue_expired" })
      .where(and(eq(masterStorageOperationsTable.state, "queued"), lt(masterStorageOperationsTable.dispatchedAt, staleQueuedAt)));
    // Only safe-to-repeat interrupted processing is returned to the dispatcher.
    await tx.update(masterStorageOperationsTable).set({ state: "failed", retryable: true, retryAfterAt: new Date(), claimToken: null, claimedAt: null, diagnosticCode: "worker_interrupted" })
      .where(and(eq(masterStorageOperationsTable.state, "processing"), lt(masterStorageOperationsTable.claimedAt, staleProcessingAt), lt(masterStorageOperationsTable.attempts, maxAttempts)));
    const exhausted = await tx.update(masterStorageOperationsTable).set({
      state: "reconciliation_required", retryable: false, completedAt: new Date(), claimToken: null, claimedAt: null,
      diagnosticCode: "worker_interrupted_attempts_exhausted", retryAfterAt: null,
    }).where(and(eq(masterStorageOperationsTable.state, "processing"), lt(masterStorageOperationsTable.claimedAt, staleProcessingAt), eq(masterStorageOperationsTable.attempts, maxAttempts))).returning();
    const failed = await tx.update(masterStorageOperationsTable).set({
      retryable: false, completedAt: new Date(), retryAfterAt: null, diagnosticCode: "attempts_exhausted",
    }).where(and(eq(masterStorageOperationsTable.state, "failed"), eq(masterStorageOperationsTable.retryable, true), eq(masterStorageOperationsTable.attempts, maxAttempts))).returning();
    for (const item of [...exhausted, ...failed]) await terminalAudit(tx, item);
  });
  let dispatched = 0;
  for (let i = 0; i < 100; i++) {
    const candidate = await workerTransaction(async (tx) => {
      const claim = randomUUID(), stale = new Date(Date.now() - 5 * 60_000);
      const claimable = or(
        eq(masterStorageOperationsTable.state, "pending"),
        and(eq(masterStorageOperationsTable.state, "failed"), eq(masterStorageOperationsTable.retryable, true), or(lt(masterStorageOperationsTable.retryAfterAt, new Date()), sql`${masterStorageOperationsTable.retryAfterAt} is null`)),
        and(eq(masterStorageOperationsTable.state, "dispatching"), lt(masterStorageOperationsTable.claimedAt, stale)),
      );
      const [row] = await tx.select({ id: masterStorageOperationsTable.id }).from(masterStorageOperationsTable).where(and(claimable, lt(masterStorageOperationsTable.attempts, maxAttempts))).orderBy(masterStorageOperationsTable.createdAt).limit(1);
      if (!row) return undefined;
       const [claimed] = await tx.update(masterStorageOperationsTable).set({
         state: "dispatching",
         claimToken: claim,
         claimedAt: new Date(),
         retryAfterAt: null,
         diagnosticCode: null,
         dispatchGeneration: sql`${masterStorageOperationsTable.dispatchGeneration} + 1`,
       }).where(and(eq(masterStorageOperationsTable.id, row.id), claimable)).returning({ id: masterStorageOperationsTable.id, generation: masterStorageOperationsTable.dispatchGeneration });
      return claimed ? { id: row.id, claim, generation: claimed.generation } : undefined;
    });
    if (!candidate) break;
    try {
      await enqueue({ operationId: candidate.id, generation: candidate.generation });
      await workerTransaction((tx) => tx.update(masterStorageOperationsTable).set({
        state: "queued",
        dispatchedAt: new Date(),
        claimToken: null,
        claimedAt: null,
      }).where(and(eq(masterStorageOperationsTable.id, candidate.id), eq(masterStorageOperationsTable.claimToken, candidate.claim))));
      dispatched++;
    } catch {
      await workerTransaction((tx) => tx.update(masterStorageOperationsTable).set({
        state: "failed",
        retryable: true,
        retryAfterAt: new Date(Date.now() + 30_000),
        claimToken: null,
        claimedAt: null,
        diagnosticCode: "enqueue_failed",
      }).where(and(
        eq(masterStorageOperationsTable.id, candidate.id),
        eq(masterStorageOperationsTable.claimToken, candidate.claim),
      )));
    }
  }
  return { dispatched };
}

export async function processMasterStorageOperation(id: string, storage: ColdMasterStorage = getRuntimeColdMasterStorage(), transfer: ColdMasterTransfer = getRuntimeColdMasterTransfer(), generation?: number) {
  const claim = randomUUID();
  const row = await workerTransaction(async (tx) => {
    const [claimed] = await tx.update(masterStorageOperationsTable).set({
      state: "processing",
      claimToken: claim,
      claimedAt: new Date(),
      attemptedAt: new Date(),
      retryAfterAt: null,
      attempts: sql`${masterStorageOperationsTable.attempts} + 1`,
    }).where(and(eq(masterStorageOperationsTable.id, id), ...(generation === undefined ? [] : [eq(masterStorageOperationsTable.dispatchGeneration, generation)]), inArray(masterStorageOperationsTable.state, ["queued", "pending", "dispatching"]), lt(masterStorageOperationsTable.attempts, maxAttempts))).returning();
    return claimed;
  });
  if (!row) return { skipped: true };
  const snapshot = {
    providerAccountId: row.providerAccountId,
    providerTenantSpaceId: row.providerTenantSpaceId,
    providerAssetId: row.providerAssetId,
  };
  const preflight = await workerTransaction(async (tx) => {
    const [video] = await tx.select({
      status: videosTable.status,
      uploadSourceBytes: videosTable.uploadSourceBytes,
      uploadSourceContentType: videosTable.uploadSourceContentType,
    }).from(videosTable).where(and(
      eq(videosTable.id, row.videoId),
      eq(videosTable.organizationId, row.organizationId),
      eq(videosTable.providerAccountId, row.providerAccountId),
      eq(videosTable.providerTenantSpaceId, row.providerTenantSpaceId),
      eq(videosTable.providerAssetId, row.providerAssetId),
      isNull(videosTable.deletionClaim),
      isNull(videosTable.reconciliationRequired),
    )).limit(1);
    return video;
  });
  if (!preflight || (row.operation === "archive" && preflight.status !== "ready")) {
    await reconcile(row, claim, "video_snapshot_changed");
    return { reconciliationRequired: true };
  }
  let restoreWriteStarted = false;
  let restoreAttestation: Record<string, unknown> | undefined;
  try {
    if (row.operation === "archive") {
      const source = await transfer.openSource(snapshot);
      if (
        !sameProviderSnapshot(source.source, snapshot)
        || !Number.isSafeInteger(source.contentLength)
        || source.contentLength < 1
        || !/^[a-f0-9]{64}$/.test(source.sha256)
        || !validContentType(source.contentType)
        || (preflight.uploadSourceBytes !== null && source.contentLength !== preflight.uploadSourceBytes)
        || (preflight.uploadSourceContentType !== null && source.contentType !== preflight.uploadSourceContentType)
      ) {
        throw new ColdMasterTransferDefinitiveError("invalid_snapshot");
      }
      const storageKey = createColdMasterObjectKey({ organizationId: row.organizationId, videoId: row.videoId, sha256: source.sha256 });
      const tracked = trackedStream(source.body, source.contentLength);
      let archived;
      try {
        archived = await storage.archive({ storageKey, contentLength: source.contentLength, contentType: source.contentType, sha256: source.sha256, body: tracked.body });
        tracked.verify(source.contentLength, source.sha256);
      } finally {
        await tracked.close().catch(() => undefined);
      }
      if (archived.storageKey !== storageKey || archived.size !== source.contentLength || archived.contentType !== source.contentType || archived.sha256 !== source.sha256) {
        throw new ColdMasterIntegrityMismatchError(storageKey);
      }
      const outcome = await complete(row, claim, { storageKey, size: source.contentLength, contentType: source.contentType, sha256: source.sha256 });
      if (outcome !== "completed") return outcome === "reconciliation_required" ? { reconciliationRequired: true } : { skipped: true };
    } else {
      if (
        !Number.isSafeInteger(row.restoreSizeBytes)
        || (row.restoreSizeBytes ?? 0) < 1
        || !/^[a-f0-9]{64}$/.test(row.restoreSha256 ?? "")
        || !validContentType(row.restoreContentType)
      ) {
        throw new ColdMasterIntegrityMismatchError(row.restoreStorageKey ?? "");
      }
      const restored = await storage.restore(row.restoreStorageKey!);
      if (restored.storageKey !== row.restoreStorageKey || restored.size !== row.restoreSizeBytes || restored.contentType !== row.restoreContentType || restored.sha256 !== row.restoreSha256) throw new ColdMasterIntegrityMismatchError(row.restoreStorageKey!);
      const tracked = trackedStream(restored.body, row.restoreSizeBytes!);
      let target;
      try {
        restoreWriteStarted = true;
        target = await transfer.restoreToTarget({ target: snapshot, idempotencyKey: row.idempotencyKey, contentLength: row.restoreSizeBytes!, contentType: row.restoreContentType!, sha256: row.restoreSha256!, body: tracked.body });
        restoreAttestation = {
          providerAccountId: target.target.providerAccountId,
          providerTenantSpaceId: target.target.providerTenantSpaceId,
          providerAssetId: target.target.providerAssetId,
          ...(target.targetVersion ? { targetVersion: target.targetVersion } : {}),
          idempotencyKey: target.idempotencyKey,
          contentLength: target.contentLength,
          contentType: target.contentType,
          sha256: target.sha256,
        };
        tracked.verify(row.restoreSizeBytes!, row.restoreSha256!);
      } finally {
        await tracked.close().catch(() => undefined);
      }
      if (!sameProviderSnapshot(target.target, snapshot)
        || target.idempotencyKey !== row.idempotencyKey
        || target.contentLength !== row.restoreSizeBytes
        || target.contentType !== row.restoreContentType
        || target.sha256 !== row.restoreSha256) {
        throw new ColdMasterIntegrityMismatchError(row.restoreStorageKey!);
      }
      const outcome = await complete(row, claim, {
        size: row.restoreSizeBytes,
        contentType: row.restoreContentType,
        sha256: row.restoreSha256,
        ...(target.targetVersion ? { targetVersion: target.targetVersion } : {}),
      });
      if (outcome !== "completed") return outcome === "reconciliation_required" ? { reconciliationRequired: true } : { skipped: true };
    }
    return { completed: true };
  } catch (error) {
    const ambiguous = error instanceof ColdMasterTransferAmbiguousError
      || (restoreWriteStarted
        && !(error instanceof ColdMasterTransferTransientError)
        && !(error instanceof ColdMasterTransferUnavailableError)
        && !(error instanceof ColdMasterTransferDefinitiveError));
    if (ambiguous) {
      await reconcile(row, claim, "transfer_ambiguous", restoreAttestation ?? { restoreWriteStarted: true });
      return { reconciliationRequired: true };
    }
    const definitive = error instanceof ColdMasterDefinitiveWriteRejectionError || error instanceof ColdMasterIntegrityMismatchError || error instanceof ColdMasterObjectNotFoundError || error instanceof ColdMasterTransferDefinitiveError;
    const retryable = !definitive && row.attempts < maxAttempts;
    const code = error instanceof ColdMasterStorageUnavailableError || error instanceof ColdMasterTransferUnavailableError ? "adapter_unavailable"
      : error instanceof ColdMasterObjectNotFoundError ? "object_not_found"
        : error instanceof ColdMasterIntegrityMismatchError ? "integrity_mismatch"
          : error instanceof ColdMasterDefinitiveWriteRejectionError ? "write_rejected"
            : error instanceof ColdMasterTransferDefinitiveError ? "transfer_rejected"
              : error instanceof ColdMasterTransferTransientError ? "transient" : "unknown";
    await fail(row, claim, retryable, code);
    if (error instanceof ColdMasterTransferTransientError || error instanceof ColdMasterStorageUnavailableError || error instanceof ColdMasterTransferUnavailableError) return { retryable: true };
    return { failed: true };
  }
}
async function complete(
  row: typeof masterStorageOperationsTable.$inferSelect,
  claim: string,
  result: Record<string, unknown>,
): Promise<"completed" | "skipped" | "reconciliation_required"> {
  return workerTransaction(async (tx) => {
    const [owned] = await tx.select({ id: masterStorageOperationsTable.id }).from(masterStorageOperationsTable).where(and(
      eq(masterStorageOperationsTable.id, row.id),
      eq(masterStorageOperationsTable.state, "processing"),
      eq(masterStorageOperationsTable.claimToken, claim),
    )).for("update").limit(1);
    if (!owned) return "skipped";
    const [video] = await tx.select({
      title: videosTable.title,
      masterStorageKey: videosTable.masterStorageKey,
    }).from(videosTable).where(and(
      eq(videosTable.id, row.videoId),
      eq(videosTable.organizationId, row.organizationId),
      eq(videosTable.providerAccountId, row.providerAccountId),
      eq(videosTable.providerTenantSpaceId, row.providerTenantSpaceId),
      eq(videosTable.providerAssetId, row.providerAssetId),
      isNull(videosTable.deletionClaim),
      isNull(videosTable.reconciliationRequired),
    )).for("update").limit(1);
    if (!video || (row.operation === "archive" && video.masterStorageKey !== null)) {
      const [changed] = await tx.update(masterStorageOperationsTable).set({
        state: "reconciliation_required",
        retryable: false,
        completedAt: new Date(),
        retryAfterAt: null,
        claimToken: null,
        claimedAt: null,
        diagnosticCode: "video_snapshot_changed",
        resultMetadata: result,
      }).where(and(
        eq(masterStorageOperationsTable.id, row.id),
        eq(masterStorageOperationsTable.claimToken, claim),
      )).returning();
      if (changed) await terminalAudit(tx, changed);
      return "reconciliation_required";
    }
    if (row.operation === "archive") {
      const [updated] = await tx.update(videosTable).set({
        masterStorageKey: result.storageKey as string,
        masterArchivedAt: new Date(),
        masterSha256: result.sha256 as string,
        masterSizeBytes: result.size as number,
        masterContentType: result.contentType as string,
      }).where(and(
        eq(videosTable.id, row.videoId),
        eq(videosTable.organizationId, row.organizationId),
        eq(videosTable.providerAccountId, row.providerAccountId),
        eq(videosTable.providerTenantSpaceId, row.providerTenantSpaceId),
        eq(videosTable.providerAssetId, row.providerAssetId),
        isNull(videosTable.deletionClaim),
        isNull(videosTable.reconciliationRequired),
        isNull(videosTable.masterStorageKey),
      )).returning({ id: videosTable.id });
      if (!updated) throw new Error("Master archive video snapshot changed while locked");
    }
    const [changed] = await tx.update(masterStorageOperationsTable).set({
      state: "completed",
      retryable: false,
      completedAt: new Date(),
      retryAfterAt: null,
      claimToken: null,
      claimedAt: null,
      diagnosticCode: null,
      resultMetadata: result,
    }).where(and(
      eq(masterStorageOperationsTable.id, row.id),
      eq(masterStorageOperationsTable.claimToken, claim),
    )).returning();
    if (!changed) throw new Error("Master operation claim changed while locked");
    await writeAuditEvent(tx, {
      organizationId: row.organizationId,
      actor: auditJob(),
      action: `master_storage.${row.operation}_completed`,
      category: "content",
      subject: { type: "video", id: row.videoId, label: video.title },
      afterState: { operation: row.operation, state: "completed" },
    });
    return "completed";
  });
}
async function fail(row: typeof masterStorageOperationsTable.$inferSelect, claim: string, retryable: boolean, code: string) {
  await workerTransaction(async (tx) => {
    const [changed] = await tx.update(masterStorageOperationsTable).set({
      state: "failed",
      retryable,
      claimToken: null,
      claimedAt: null,
      diagnosticCode: code,
      retryAfterAt: retryable ? new Date(Date.now() + 30_000 * Math.max(1, row.attempts)) : null,
      completedAt: retryable ? null : new Date(),
    }).where(and(eq(masterStorageOperationsTable.id, row.id), eq(masterStorageOperationsTable.claimToken, claim))).returning();
    if (!changed || retryable) return;
    await terminalAudit(tx, changed);
  });
}
async function reconcile(
  row: typeof masterStorageOperationsTable.$inferSelect,
  claim: string,
  code: string,
  resultMetadata?: Record<string, unknown>,
) {
  await workerTransaction(async (tx) => {
    const [changed] = await tx.update(masterStorageOperationsTable).set({
      state: "reconciliation_required",
      retryable: false,
      claimToken: null,
      claimedAt: null,
      retryAfterAt: null,
      completedAt: new Date(),
      diagnosticCode: code,
      ...(resultMetadata ? { resultMetadata } : {}),
    }).where(and(
      eq(masterStorageOperationsTable.id, row.id),
      eq(masterStorageOperationsTable.claimToken, claim),
    )).returning();
    if (changed) await terminalAudit(tx, changed);
  });
}
async function terminalAudit(tx: TenantTransaction, row: typeof masterStorageOperationsTable.$inferSelect) {
  const [video] = await tx.select({ title: videosTable.title }).from(videosTable).where(and(
    eq(videosTable.id, row.videoId),
    eq(videosTable.organizationId, row.organizationId),
  )).limit(1);
  if (video) await writeAuditEvent(tx, { organizationId: row.organizationId, actor: auditJob(), action: `master_storage.${row.operation}_failed`, category: "content", subject: { type: "video", id: row.videoId, label: video.title }, afterState: { operation: row.operation, state: row.state, retryable: false }, metadata: { code: row.diagnosticCode } });
}