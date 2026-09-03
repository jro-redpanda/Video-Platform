import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  objectCleanupOutboxTable,
  thumbnailUploadIntentsTable,
  videosTable,
} from "@workspace/db";
import {
  CreateThumbnailUploadIntentBody,
  CreateThumbnailUploadIntentParams,
  CreateThumbnailUploadIntentResponse,
  DeleteVideoThumbnailParams,
  FinalizeThumbnailBody,
  FinalizeThumbnailParams,
  FinalizeThumbnailResponse,
  GetVideoThumbnailParams,
} from "@workspace/api-zod";
import { requirePermission } from "../lib/permissions";
import { requireCreateAccess } from "../lib/entitlements";
import { withTenantDb } from "../lib/tenant-db";
import { auditDiff, auditUser, writeAuditEvent } from "../lib/audit";
import {
  getThumbnailStorage,
  ThumbnailObjectNotFoundError,
  type ThumbnailStorage,
} from "../lib/thumbnail-storage";

const router: IRouter = Router();
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxBytes = 10 * 1024 * 1024;

router.post(
  "/videos/:videoId/thumbnail-upload-intent",
  requirePermission("videos.update"),
  requireCreateAccess,
  async (req, res): Promise<void> => {
    const { videoId } = CreateThumbnailUploadIntentParams.parse(req.params);
    const parsed = CreateThumbnailUploadIntentBody.safeParse(req.body);
    if (!parsed.success || !isExactObject(req.body, ["contentType", "sizeBytes"])) {
      res.status(400).json({ error: "Invalid thumbnail upload metadata." });
      return;
    }
    const { contentType, sizeBytes } = parsed.data;
    if (!allowedTypes.has(contentType) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) {
      res.status(400).json({ error: "Thumbnail must be a JPEG, PNG, or WebP between 1 byte and 10 MiB." });
      return;
    }
    const intentId = randomUUID();
    // Sidecar signing cannot constrain length/generation. The candidate is
    // never served; finalize enforces size and immutably promotes a generation.
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const objectKey = `thumbnail-candidates/${req.tenant.organizationId}/${videoId}/${intentId}`;
    const inserted = await withTenantDb(req.tenant, async (tx) => {
      const [video] = await tx.select({
        id: videosTable.id,
        deletionClaim: videosTable.deletionClaim,
      }).from(videosTable).where(and(
        eq(videosTable.organizationId, req.tenant.organizationId),
        eq(videosTable.id, videoId),
      )).for("update").limit(1);
      if (!video) return false;
      if (video.deletionClaim) throw new ThumbnailLifecycleError();
      await tx.insert(thumbnailUploadIntentsTable).values({
        id: intentId,
        organizationId: req.tenant.organizationId,
        videoId,
        objectKey,
        declaredContentType: contentType,
        declaredSizeBytes: sizeBytes,
        expiresAt,
      });
      return true;
    }).catch((error: unknown) => {
      if (error instanceof ThumbnailLifecycleError) return "deleting" as const;
      throw error;
    });
    if (!inserted) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    if (inserted === "deleting") {
      res.status(409).json({ error: "Video deletion is in progress" });
      return;
    }
    try {
      const signed = await storage(req).createSignedPutUrl(objectKey, contentType, expiresAt);
      res.status(201).json(CreateThumbnailUploadIntentResponse.parse({
        intentId, ...signed, expiresAt,
      }));
    } catch (error) {
      req.log.error({ err: error, videoId, intentId }, "Thumbnail upload URL signing failed");
      res.status(503).json({ error: "Thumbnail storage is unavailable" });
    }
  },
);

router.post(
  "/videos/:videoId/thumbnail-finalize",
  requirePermission("videos.update"),
  async (req, res): Promise<void> => {
    const { videoId } = FinalizeThumbnailParams.parse(req.params);
    const parsed = FinalizeThumbnailBody.safeParse(req.body);
    if (!parsed.success || !isExactObject(req.body, ["intentId"])) {
      res.status(400).json({ error: "Invalid thumbnail finalize request." });
      return;
    }
    try {
      const result = await withTenantDb(req.tenant, async (tx) => {
        // Lifecycle lock order is always video first, then its intent.
        const [video] = await tx.select({
          id: videosTable.id,
          title: videosTable.title,
          deletionClaim: videosTable.deletionClaim,
          thumbnailObjectKey: videosTable.thumbnailObjectKey,
          thumbnailContentType: videosTable.thumbnailContentType,
          thumbnailSizeBytes: videosTable.thumbnailSizeBytes,
          thumbnailVersion: videosTable.thumbnailVersion,
          thumbnailMutableUntil: videosTable.thumbnailMutableUntil,
        }).from(videosTable).where(and(
          eq(videosTable.organizationId, req.tenant.organizationId),
          eq(videosTable.id, videoId),
        )).for("update").limit(1);
        if (!video) throw new ThumbnailFinalizeError(404, "Video or upload intent not found");
        if (video.deletionClaim) throw new ThumbnailFinalizeError(409, "Video deletion is in progress");
        const [intent] = await tx.select().from(thumbnailUploadIntentsTable).where(and(
          eq(thumbnailUploadIntentsTable.id, parsed.data.intentId),
          eq(thumbnailUploadIntentsTable.organizationId, req.tenant.organizationId),
          eq(thumbnailUploadIntentsTable.videoId, videoId),
        )).for("update").limit(1);
        if (!intent) throw new ThumbnailFinalizeError(404, "Video or upload intent not found");
        if (intent.finalizedAt) {
          if (!intent.finalizedObjectKey || !intent.finalizedContentType
            || !intent.finalizedSizeBytes || !intent.finalizedVersion) {
            throw new ThumbnailFinalizeError(409, "Finalized thumbnail metadata is incomplete");
          }
          return thumbnailResponse(videoId, intent.finalizedContentType, intent.finalizedSizeBytes, intent.finalizedVersion);
        }
        if (intent.expiresAt.getTime() <= Date.now()) {
          throw new ThumbnailFinalizeError(409, "Thumbnail upload intent has expired");
        }
        const metadata = await storage(req).getMetadata(intent.objectKey);
        if (!metadata.contentType || metadata.contentType !== intent.declaredContentType
          || !allowedTypes.has(metadata.contentType)) {
          throw new ThumbnailFinalizeError(400, "Uploaded thumbnail Content-Type does not match the intent");
        }
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > maxBytes
          || metadata.size !== intent.declaredSizeBytes) {
          throw new ThumbnailFinalizeError(400, "Uploaded thumbnail size is invalid");
        }
        const signature = await storage(req).readRange(intent.objectKey, metadata.generation, 0, 15);
        if (sniffImageType(signature) !== metadata.contentType) {
          throw new ThumbnailFinalizeError(400, "Uploaded thumbnail bytes do not match its Content-Type");
        }
        const finalVersion = randomUUID();
        const finalObjectKey = `thumbnail-finals/${req.tenant.organizationId}/${videoId}/${randomUUID()}`;
        // Commit a delayed compensation before the external copy. If this
        // transaction or process dies after copy, the final object is deleted.
        await withTenantDb(req.tenant, (compensationTx) =>
          compensationTx.insert(objectCleanupOutboxTable).values({
            organizationId: req.tenant.organizationId,
            objectKey: finalObjectKey,
            nextAttemptAt: new Date(Date.now() + 15 * 60_000),
          }));
        const promoted = await storage(req).promoteObject(
          intent.objectKey,
          metadata.generation,
          finalObjectKey,
          metadata.contentType,
        );
        const promotedSignature = await storage(req).readRange(finalObjectKey, promoted.generation, 0, 15);
        if (promoted.contentType !== metadata.contentType || promoted.size !== metadata.size
          || !promoted.generation || sniffImageType(promotedSignature) !== metadata.contentType) {
          req.log.warn({
            expectedContentType: metadata.contentType,
            promotedContentType: promoted.contentType ?? null,
            expectedSizeBytes: metadata.size,
            promotedSizeBytes: promoted.size,
            promotedGenerationPresent: Boolean(promoted.generation),
            promotedMagicMatches: sniffImageType(promotedSignature) === metadata.contentType,
          }, "Promoted thumbnail metadata mismatch");
          throw new ThumbnailFinalizeError(400, "Promoted thumbnail failed integrity verification");
        }
        const afterCopy = req.app.locals.thumbnailFinalizeAfterCopy as (() => Promise<void>) | undefined;
        if (afterCopy) await afterCopy();
        await tx.update(videosTable).set({
          thumbnailObjectKey: finalObjectKey,
          thumbnailContentType: metadata.contentType,
          thumbnailSizeBytes: metadata.size,
          thumbnailVersion: finalVersion,
          thumbnailGeneration: promoted.generation,
          thumbnailMutableUntil: null,
        }).where(and(eq(videosTable.organizationId, req.tenant.organizationId), eq(videosTable.id, videoId)));
        await tx.update(thumbnailUploadIntentsTable).set({
          finalizedAt: new Date(),
          finalizedObjectKey: finalObjectKey,
          finalizedVersion: finalVersion,
          finalizedContentType: metadata.contentType,
          finalizedSizeBytes: metadata.size,
          finalizedGeneration: promoted.generation,
        })
          .where(eq(thumbnailUploadIntentsTable.id, intent.id));
        await tx.delete(objectCleanupOutboxTable).where(and(
          eq(objectCleanupOutboxTable.organizationId, req.tenant.organizationId),
          eq(objectCleanupOutboxTable.objectKey, finalObjectKey),
        ));
        await enqueueCleanup(tx, req.tenant.organizationId, intent.objectKey);
        if (video.thumbnailObjectKey && video.thumbnailObjectKey !== intent.objectKey) {
          await enqueueCleanup(tx, req.tenant.organizationId, video.thumbnailObjectKey);
        }
        await writeAuditEvent(tx, {
          organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
          action: "thumbnail.updated", category: "content",
          subject: { type: "video", id: videoId, label: video.title },
          ...auditDiff(
            { present: Boolean(video.thumbnailObjectKey), contentType: video.thumbnailContentType, sizeBytes: video.thumbnailSizeBytes },
            { present: true, contentType: metadata.contentType, sizeBytes: metadata.size },
          ),
          requestId: String(req.id),
        });
        return thumbnailResponse(videoId, metadata.contentType, metadata.size, finalVersion);
      });
      res.json(FinalizeThumbnailResponse.parse(result));
    } catch (error) {
      if (error instanceof ThumbnailFinalizeError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof ThumbnailObjectNotFoundError) {
        res.status(400).json({ error: "Uploaded thumbnail object was not found" });
        return;
      }
      req.log.error({ err: error, videoId }, "Thumbnail finalize failed");
      res.status(503).json({ error: "Thumbnail storage is unavailable" });
    }
  },
);

router.delete(
  "/videos/:videoId/thumbnail",
  requirePermission("videos.update"),
  async (req, res): Promise<void> => {
    const { videoId } = DeleteVideoThumbnailParams.parse(req.params);
    const result = await withTenantDb(req.tenant, async (tx) => {
      const [video] = await tx.select({
        title: videosTable.title,
        deletionClaim: videosTable.deletionClaim,
        thumbnailObjectKey: videosTable.thumbnailObjectKey,
      }).from(videosTable).where(and(
        eq(videosTable.organizationId, req.tenant.organizationId),
        eq(videosTable.id, videoId),
      )).for("update").limit(1);
      if (!video) return false;
      if (video.deletionClaim) return "deleting" as const;
      if (!video.thumbnailObjectKey) return "unchanged" as const;
      await tx.update(videosTable).set({
        thumbnailObjectKey: null, thumbnailContentType: null, thumbnailSizeBytes: null,
        thumbnailVersion: null, thumbnailGeneration: null, thumbnailMutableUntil: null,
      }).where(and(eq(videosTable.organizationId, req.tenant.organizationId), eq(videosTable.id, videoId)));
      if (video.thumbnailObjectKey) await enqueueCleanup(tx, req.tenant.organizationId, video.thumbnailObjectKey);
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: "thumbnail.removed", category: "content",
        subject: { type: "video", id: videoId, label: video.title },
        beforeState: { present: true }, afterState: { present: false }, requestId: String(req.id),
      });
      return true;
    });
    if (!result) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    if (result === "deleting") {
      res.status(409).json({ error: "Video deletion is in progress" });
      return;
    }
    res.sendStatus(204);
  },
);

router.get(
  "/videos/:videoId/thumbnail",
  requirePermission("videos.read"),
  async (req, res): Promise<void> => {
    const { videoId } = GetVideoThumbnailParams.parse(req.params);
    const [video] = await withTenantDb(req.tenant, (tx) => tx.select({
      objectKey: videosTable.thumbnailObjectKey,
      contentType: videosTable.thumbnailContentType,
      sizeBytes: videosTable.thumbnailSizeBytes,
      version: videosTable.thumbnailVersion,
      generation: videosTable.thumbnailGeneration,
      mutableUntil: videosTable.thumbnailMutableUntil,
    }).from(videosTable).where(and(
      eq(videosTable.organizationId, req.tenant.organizationId),
      eq(videosTable.id, videoId),
    )).limit(1));
    if (!video?.objectKey || !video.contentType || !video.sizeBytes || !video.version
      || (video.mutableUntil && video.mutableUntil.getTime() > Date.now())
      || req.query.v !== video.version) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }
    const objectStorage = storage(req);
    try {
      const actual = await objectStorage.getMetadata(video.objectKey, video.generation ?? undefined);
      if (actual.contentType !== video.contentType || actual.size !== video.sizeBytes) {
        throw new Error("Stored thumbnail metadata changed after finalization");
      }
      if (video.generation && actual.generation !== video.generation) {
        throw new Error("Stored thumbnail generation changed after finalization");
      }
      streamThumbnail(res, objectStorage, {
        objectKey: video.objectKey,
        contentType: video.contentType,
        sizeBytes: video.sizeBytes,
        generation: video.generation ?? undefined,
      });
    } catch (error) {
      if (error instanceof ThumbnailObjectNotFoundError) {
        res.status(404).json({ error: "Thumbnail not found" });
        return;
      }
      req.log.error({ err: error, videoId }, "Thumbnail serving failed");
      res.status(503).json({ error: "Thumbnail storage is unavailable" });
    }
  },
);

function storage(req: { app: { locals: Record<string, unknown> } }) {
  return getThumbnailStorage(req.app.locals);
}

export function streamThumbnail(
  res: Response,
  objectStorage: ThumbnailStorage,
  thumbnail: { objectKey: string; contentType: string; sizeBytes: number; generation?: string },
  publiclyCacheable = false,
) {
  if (!allowedTypes.has(thumbnail.contentType) || thumbnail.sizeBytes < 1 || thumbnail.sizeBytes > maxBytes) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }
  res.setHeader("Content-Type", thumbnail.contentType);
  res.setHeader("Content-Length", String(thumbnail.sizeBytes));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", `${publiclyCacheable ? "public" : "private"}, max-age=31536000, immutable`);
  const source = objectStorage.createReadStream(thumbnail.objectKey, thumbnail.generation);
  source.on("error", () => res.destroy());
  source.pipe(res);
}

function thumbnailResponse(videoId: string, contentType: string, sizeBytes: number, version: string) {
  return { thumbnailUrl: `/api/videos/${videoId}/thumbnail?v=${version}`, contentType, sizeBytes };
}

function sniffImageType(bytes: Buffer) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function enqueueCleanup(
  tx: Parameters<Parameters<typeof withTenantDb>[1]>[0],
  organizationId: string,
  objectKey: string,
) {
  await tx.insert(objectCleanupOutboxTable).values({ organizationId, objectKey }).onConflictDoNothing({
    target: objectCleanupOutboxTable.objectKey,
  });
}

function isExactObject(value: unknown, keys: string[]) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

class ThumbnailFinalizeError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

class ThumbnailLifecycleError extends Error {}

export default router;