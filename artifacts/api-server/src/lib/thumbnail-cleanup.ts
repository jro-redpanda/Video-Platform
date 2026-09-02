import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db, objectCleanupOutboxTable, thumbnailUploadIntentsTable, videosTable } from "@workspace/db";
import { getThumbnailStorage, type ThumbnailStorage } from "./thumbnail-storage";
import { logger } from "./logger";
import type { TenantTransaction } from "./tenant-db";

const batchLimit = 100;
export const MAX_THUMBNAIL_CLEANUP_ATTEMPTS = 8;

/**
 * Moves expired, never-finalized candidates to the durable deletion outbox,
 * then performs due deletions. Safe to invoke concurrently.
 */
export async function cleanupThumbnailObjects(
  storage: ThumbnailStorage = getThumbnailStorage(),
  now = new Date(),
) {
  const candidates = await withWorkerDb((tx) => tx.select({
    id: thumbnailUploadIntentsTable.id,
    organizationId: thumbnailUploadIntentsTable.organizationId,
    videoId: thumbnailUploadIntentsTable.videoId,
  }).from(thumbnailUploadIntentsTable).where(and(
    isNull(thumbnailUploadIntentsTable.finalizedAt),
    lte(thumbnailUploadIntentsTable.expiresAt, now),
  )).limit(batchLimit));
  let expired = 0;
  for (const candidate of candidates) {
    expired += await withWorkerDb(async (tx) => {
      // The same lifecycle order used by routes: video row, then intent row.
      await tx.execute(sql`select lock_thumbnail_cleanup_video(${candidate.videoId}::uuid)`);
      const [video] = await tx.select({
        id: videosTable.id,
        deletionClaim: videosTable.deletionClaim,
        thumbnailObjectKey: videosTable.thumbnailObjectKey,
      }).from(videosTable).where(and(
        eq(videosTable.organizationId, candidate.organizationId),
        eq(videosTable.id, candidate.videoId),
      )).limit(1);
      if (!video || video.deletionClaim) return 0;
      await tx.execute(sql`select lock_thumbnail_cleanup_intent(${candidate.id}::uuid)`);
      const [intent] = await tx.select({
        id: thumbnailUploadIntentsTable.id,
        objectKey: thumbnailUploadIntentsTable.objectKey,
      }).from(thumbnailUploadIntentsTable).where(and(
        eq(thumbnailUploadIntentsTable.id, candidate.id),
        eq(thumbnailUploadIntentsTable.organizationId, candidate.organizationId),
        eq(thumbnailUploadIntentsTable.videoId, candidate.videoId),
        isNull(thumbnailUploadIntentsTable.finalizedAt),
        lte(thumbnailUploadIntentsTable.expiresAt, now),
      )).limit(1);
      if (!intent) return 0;
      // A pre-integrity upload may still be the active thumbnail. Its signed
      // capability horizon controls serving, but cleanup must never delete an
      // object while the video references it.
      if (video.thumbnailObjectKey === intent.objectKey) return 0;
      await tx.insert(objectCleanupOutboxTable).values({
        organizationId: candidate.organizationId,
        objectKey: intent.objectKey,
      })
        .onConflictDoNothing({ target: objectCleanupOutboxTable.objectKey });
      await tx.delete(thumbnailUploadIntentsTable).where(eq(thumbnailUploadIntentsTable.id, intent.id));
      return 1;
    });
  }

  let completed = 0;
  let failed = 0;
  let quarantined = 0;
  for (let i = 0; i < batchLimit; i++) {
    const claimUntil = new Date(now.getTime() + 5 * 60_000);
    const candidate = await withWorkerDb(async (tx) => {
      const [row] = await tx.select({
        id: objectCleanupOutboxTable.id,
        objectKey: objectCleanupOutboxTable.objectKey,
        attempts: objectCleanupOutboxTable.attempts,
      }).from(objectCleanupOutboxTable).where(and(
        isNull(objectCleanupOutboxTable.completedAt),
        isNull(objectCleanupOutboxTable.quarantinedAt),
        lte(objectCleanupOutboxTable.nextAttemptAt, now),
      )).orderBy(objectCleanupOutboxTable.createdAt).limit(1);
      if (!row) return undefined;
      const [claimed] = await tx.update(objectCleanupOutboxTable).set({
        attempts: sql`${objectCleanupOutboxTable.attempts} + 1`,
        nextAttemptAt: claimUntil,
        lastError: null,
      }).where(and(
        eq(objectCleanupOutboxTable.id, row.id),
        isNull(objectCleanupOutboxTable.completedAt),
        isNull(objectCleanupOutboxTable.quarantinedAt),
        lte(objectCleanupOutboxTable.nextAttemptAt, now),
      )).returning({ id: objectCleanupOutboxTable.id });
      return claimed ? row : undefined;
    });
    if (!candidate) break;
    try {
      await storage.deleteObject(candidate.objectKey);
      await withWorkerDb((tx) => tx.update(objectCleanupOutboxTable).set({
        completedAt: new Date(),
        lastError: null,
      }).where(and(
        eq(objectCleanupOutboxTable.id, candidate.id),
        isNull(objectCleanupOutboxTable.completedAt),
      )));
      completed++;
    } catch (error) {
      const attempt = candidate.attempts + 1;
      const lastError = error instanceof Error ? error.message.slice(0, 1000) : "Unknown storage deletion error";
      if (attempt >= MAX_THUMBNAIL_CLEANUP_ATTEMPTS) {
        const quarantinedAt = new Date();
        await withWorkerDb((tx) => tx.update(objectCleanupOutboxTable).set({
          quarantinedAt,
          lastError,
        }).where(and(
          eq(objectCleanupOutboxTable.id, candidate.id),
          isNull(objectCleanupOutboxTable.completedAt),
          isNull(objectCleanupOutboxTable.quarantinedAt),
        )));
        logger.fatal({
          outboxId: candidate.id,
          attempts: attempt,
          error: lastError,
        }, "Thumbnail object cleanup exhausted retries and was quarantined");
        quarantined++;
      } else {
        const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(attempt - 1, 10)));
        await withWorkerDb((tx) => tx.update(objectCleanupOutboxTable).set({
          nextAttemptAt: new Date(now.getTime() + delayMs),
          lastError,
        }).where(and(
          eq(objectCleanupOutboxTable.id, candidate.id),
          isNull(objectCleanupOutboxTable.completedAt),
          isNull(objectCleanupOutboxTable.quarantinedAt),
        )));
      }
      failed++;
    }
  }
  return { expired, completed, failed, quarantined };
}

/** Cross-tenant cleanup is isolated to the migration-owned maintenance role. */
async function withWorkerDb<T>(operation: (tx: TenantTransaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    // The service login enters its request role first. vid_app is NOINHERIT
    // but is explicitly a member of vid_worker, so only this internal path
    // switches again to the narrow cross-tenant maintenance role.
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql.raw("set local role vid_worker"));
    return operation(tx);
  });
}