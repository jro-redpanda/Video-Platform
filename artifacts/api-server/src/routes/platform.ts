import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { runtimeConfig } from "../lib/config";
import {
  auditLogsTable,
  membershipsTable,
  organizationCustomizationTable,
  organizationsTable,
  plansTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  usersTable,
  videoAnalyticsRollupsTable,
  videosTable,
} from "@workspace/db";
import {
  GetDashboardResponse,
  GetVideoParams,
  GetVideoResponse,
  GetWorkspaceResponse,
  ListActivityResponse,
  ListVideosQueryParams,
  ListVideosResponse,
  UpdateVideoBody,
  UpdateVideoParams,
  UpdateVideoResponse,
  UpdateWorkspaceBody,
  UpdateWorkspaceResponse,
  InitializeVideoUploadBody,
  InitializeVideoUploadHeader,
  InitializeVideoUploadResponse,
} from "@workspace/api-zod";
import { withTenantDb, type TenantTransaction } from "../lib/tenant-db";
import { requirePermission } from "../lib/permissions";
import { hasEntitlement, resolveEntitlements, type EntitlementKey } from "../lib/entitlements";
import { resolveProvisioningProvider, videoProviders } from "../lib/provider-registry";
import { AssetCreationRejectedError } from "@workspace/providers";

const router: IRouter = Router();
const videoStatuses = ["created", "uploading", "processing", "ready", "error"] as const;

function isVideoStatus(value: string): value is (typeof videoStatuses)[number] {
  return videoStatuses.includes(value as (typeof videoStatuses)[number]);
}

const videoProjection = {
  id: videosTable.id,
  title: videosTable.title,
  description: videosTable.description,
  status: videosTable.status,
  visibility: videosTable.visibility,
  durationSeconds: videosTable.durationSeconds,
  createdAt: videosTable.createdAt,
  thumbnailColor: videosTable.thumbnailColor,
  plays: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)::int`,
  completionRate: sql<number>`coalesce(
    sum(${videoAnalyticsRollupsTable.completionRate} * ${videoAnalyticsRollupsTable.plays})
      / nullif(sum(${videoAnalyticsRollupsTable.plays}), 0),
    0
  )::float`,
};

function scopedVideoWhere(organizationId: string, videoId?: string) {
  return videoId
    ? and(eq(videosTable.organizationId, organizationId), eq(videosTable.id, videoId))
    : eq(videosTable.organizationId, organizationId);
}

async function readVideo(tx: TenantTransaction, organizationId: string, videoId: string) {
  const [video] = await tx.select(videoProjection)
    .from(videosTable)
    .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
    .where(scopedVideoWhere(organizationId, videoId))
    .groupBy(videosTable.id);
  return video;
}

router.get("/workspace", async (req, res) => {
  const workspace = await withTenantDb(req.tenant, (tx) => fetchWorkspace(tx, req.tenant.organizationId));

  if (!workspace) return void res.status(404).json({ error: "Workspace not found" });
  res.json(GetWorkspaceResponse.parse(workspace));
});

// workspace.manage is the Step 4 RBAC permission mapped to workspace branding changes;
// plan access is independently checked below through the entitlement guard path.
router.patch("/workspace", requirePermission("workspace.manage"), async (req, res) => {
  const raw = req.body as Record<string, unknown>;
  for (const key of ["playerAccent", "playerControlForeground", "playerControlBackground"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(raw[key]))) {
      return void res.status(400).json({ error: `${key} must be a safe six-digit hex color.` });
    }
  }
  if (raw.customDomain !== undefined && raw.customDomain !== null && (
    typeof raw.customDomain !== "string" ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(raw.customDomain)
  )) {
    return void res.status(400).json({ error: "customDomain must be a valid hostname without a protocol or path." });
  }
  const update = UpdateWorkspaceBody.parse(req.body);
  const entitlementForField: Array<[EntitlementKey, boolean]> = [
    ["branding.player_colors", Boolean(update.playerAccent || update.playerControlForeground || update.playerControlBackground || update.posterTreatment)],
    ["branding.logo", Boolean(update.logoInitials || update.logoObjectKey !== undefined)],
    ["branding.watermark", update.watermarkObjectKey !== undefined],
    ["branding.custom_domain", update.customDomain !== undefined],
  ];
  for (const [key, requested] of entitlementForField) {
    if (requested && !await hasEntitlement(req, key)) {
      return void res.status(403).json({ error: `This workspace plan does not include ${key}` });
    }
  }
  if (update.playerControlForeground || update.playerControlBackground) {
    const [current] = await withTenantDb(req.tenant, (tx) => tx.select({
      foreground: organizationCustomizationTable.playerControlForeground,
      background: organizationCustomizationTable.playerControlBackground,
    }).from(organizationCustomizationTable)
      .where(eq(organizationCustomizationTable.organizationId, req.tenant.organizationId))
      .limit(1));
    if (!current || contrastRatio(update.playerControlForeground ?? current.foreground, update.playerControlBackground ?? current.background) < 4.5) {
      return void res.status(400).json({ error: "Player control foreground and background must meet WCAG AA contrast (4.5:1)." });
    }
  }
  const response = await withTenantDb(req.tenant, async (tx) => {
    if (update.name) {
      await tx.update(organizationsTable).set({ name: update.name }).where(eq(organizationsTable.id, req.tenant.organizationId));
    }
    if (
      update.playerAccent || update.playerControlForeground || update.playerControlBackground ||
      update.logoInitials || update.logoObjectKey !== undefined || update.watermarkObjectKey !== undefined ||
      update.posterTreatment || update.customDomain !== undefined
    ) {
      await tx.update(organizationCustomizationTable).set({
        ...(update.playerAccent ? { playerAccent: update.playerAccent } : {}),
        ...(update.playerControlForeground ? { playerControlForeground: update.playerControlForeground } : {}),
        ...(update.playerControlBackground ? { playerControlBackground: update.playerControlBackground } : {}),
        ...(update.logoInitials ? { logoInitials: update.logoInitials } : {}),
        ...(update.logoObjectKey !== undefined ? { logoObjectKey: update.logoObjectKey } : {}),
        ...(update.watermarkObjectKey !== undefined ? { watermarkObjectKey: update.watermarkObjectKey } : {}),
        ...(update.posterTreatment ? { posterTreatment: update.posterTreatment } : {}),
        ...(update.customDomain !== undefined ? { customDomain: update.customDomain, customDomainVerified: false } : {}),
      }).where(eq(organizationCustomizationTable.organizationId, req.tenant.organizationId));
    }
    await tx.insert(auditLogsTable).values({
      organizationId: req.tenant.organizationId,
      actorUserId: req.tenant.userId,
      action: "updated workspace",
      subjectType: "organization",
      subjectId: req.tenant.organizationId,
      subjectLabel: update.name ?? runtimeConfig.productName,
    });
    return fetchWorkspace(tx, req.tenant.organizationId);
  });
  res.json(UpdateWorkspaceResponse.parse(response));
});

async function fetchWorkspace(tx: TenantTransaction, organizationId: string) {
  const [workspace] = await tx.select({
    id: organizationsTable.id,
    name: organizationsTable.name,
    slug: organizationsTable.slug,
    plan: plansTable.name,
    memberCount: sql<number>`count(distinct ${membershipsTable.id})::int`,
    storageUsedGb: sql<number>`${organizationsTable.storageUsedBytes}::float / 1073741824`,
    storageLimitGb: plansTable.storageLimitGb,
    playerAccent: organizationCustomizationTable.playerAccent,
    playerControlForeground: organizationCustomizationTable.playerControlForeground,
    playerControlBackground: organizationCustomizationTable.playerControlBackground,
    logoInitials: organizationCustomizationTable.logoInitials,
    logoObjectKey: organizationCustomizationTable.logoObjectKey,
    watermarkObjectKey: organizationCustomizationTable.watermarkObjectKey,
    posterTreatment: organizationCustomizationTable.posterTreatment,
    customDomain: organizationCustomizationTable.customDomain,
    customDomainVerified: organizationCustomizationTable.customDomainVerified,
  }).from(organizationsTable)
    .innerJoin(plansTable, eq(plansTable.id, organizationsTable.planId))
    .innerJoin(organizationCustomizationTable, eq(organizationCustomizationTable.organizationId, organizationsTable.id))
    .leftJoin(membershipsTable, eq(membershipsTable.organizationId, organizationsTable.id))
    .where(eq(organizationsTable.id, organizationId))
    .groupBy(organizationsTable.id, plansTable.id, organizationCustomizationTable.organizationId);
  if (!workspace) return undefined;
  return { ...workspace, entitlements: await resolveEntitlements(tx, organizationId) };
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const [a, b] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (a + 0.05) / (b + 0.05);
}

router.get("/dashboard", requirePermission("analytics.read"), async (req, res) => {
  const organizationId = req.tenant.organizationId;
  const { totals, topVideos } = await withTenantDb(req.tenant, async (tx) => {
    const [totals] = await tx.select({
    totalVideos: sql<number>`count(distinct ${videosTable.id})::int`,
    totalPlays: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)::int`,
    watchTimeHours: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.watchTimeSeconds}), 0)::float / 3600`,
    completionRate: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.completionRate} * ${videoAnalyticsRollupsTable.plays}) / nullif(sum(${videoAnalyticsRollupsTable.plays}), 0), 0)::float`,
  }).from(videosTable)
    .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
    .where(eq(videosTable.organizationId, organizationId));

    const topVideos = await tx.select(videoProjection).from(videosTable)
    .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
    .where(eq(videosTable.organizationId, organizationId))
    .groupBy(videosTable.id)
    .orderBy(desc(sql`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)`))
    .limit(3);
    return { totals, topVideos };
  });

  res.json(GetDashboardResponse.parse({
    ...totals,
    // MOCK: replaced at step 16
    playsTrend: [
      { date: "Aug 26", plays: 3820 }, { date: "Aug 27", plays: 4260 },
      { date: "Aug 28", plays: 3980 }, { date: "Aug 29", plays: 5410 },
      { date: "Aug 30", plays: 4890 }, { date: "Aug 31", plays: 5720 },
      { date: "Sep 1", plays: totals.totalPlays },
    ],
    topVideos,
  }));
});

router.get("/videos", requirePermission("videos.read"), async (req, res) => {
  const query = ListVideosQueryParams.parse(req.query);
  const conditions = [eq(videosTable.organizationId, req.tenant.organizationId)];
  if (query.search) conditions.push(ilike(videosTable.title, `%${query.search}%`));
  if (query.status && isVideoStatus(query.status)) {
    conditions.push(eq(videosTable.status, query.status));
  }

  const result = await withTenantDb(req.tenant, (tx) => tx.select(videoProjection).from(videosTable)
      .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
      .where(and(...conditions))
      .groupBy(videosTable.id)
      .orderBy(desc(videosTable.createdAt)));
  res.json(ListVideosResponse.parse(result));
});

// PRD video.upload maps to the existing Step 4 videos.create permission.
router.post("/videos/upload-init", requirePermission("videos.create"), async (req, res) => {
  const input = InitializeVideoUploadBody.parse(req.body);
  const idempotencyKey = InitializeVideoUploadHeader.parse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  })["Idempotency-Key"];
  if (!isAllowedUpload(input.fileName, input.contentType)) {
    res.status(400).json({ error: "Only safe video filenames and video MIME types are accepted." });
    return;
  }
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    res.status(400).json({ error: "contentLength must be a positive whole number." });
    return;
  }

  const spaceData = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select({ space: providerTenantSpacesTable, account: providerAccountsTable })
      .from(providerTenantSpacesTable)
      .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
      .where(and(eq(providerTenantSpacesTable.organizationId, req.tenant.organizationId), eq(providerTenantSpacesTable.state, "created")))
      .limit(1);
    return row;
  });
  if (!spaceData?.space.providerSpaceId) {
    res.status(409).json({ error: "Video provider space is not ready for this workspace." });
    return;
  }

  const reservation = await withTenantDb(req.tenant, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
    const [existing] = await tx.select().from(videosTable).where(and(
      eq(videosTable.organizationId, req.tenant.organizationId),
      eq(videosTable.uploadIdempotencyKey, idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.title !== input.title || existing.uploadSourceBytes !== input.contentLength
        || existing.uploadSourceFileName !== input.fileName || existing.uploadSourceContentType !== input.contentType) {
        throw new UploadInputError("Idempotency key was already used with different upload metadata.");
      }
      if (
        existing.quotaReleasedAt || existing.reconciliationRequired ||
        !isRetryableInitializationRecord(existing.status, existing.initializationRetryable)
      ) {
        throw new UploadReplayBlockedError("This upload is terminal and cannot be initialized again.");
      }
      return { video: existing, newlyReserved: false };
    }
    const entitlements = await resolveEntitlements(tx, req.tenant.organizationId);
    const [organization] = await tx.select({
      storageUsedBytes: organizationsTable.storageUsedBytes,
    }).from(organizationsTable).where(eq(organizationsTable.id, req.tenant.organizationId)).limit(1);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(videosTable)
      .where(eq(videosTable.organizationId, req.tenant.organizationId));
    const videoLimit = numericLimit(entitlements["limits.max_videos"]);
    const storageLimit = numericLimit(entitlements["limits.max_storage_gb"]) * 1024 ** 3;
    if (count >= videoLimit) throw new UploadInputError("Video limit reached for this workspace.");
    if (!organization || organization.storageUsedBytes + input.contentLength > storageLimit) {
      throw new UploadInputError("Storage limit reached for this workspace.");
    }

    const [video] = await tx.insert(videosTable).values({
      organizationId: req.tenant.organizationId, title: input.title, description: input.description ?? "",
      status: "created", uploadIdempotencyKey: idempotencyKey,
      uploadSourceBytes: input.contentLength, reservedBytes: input.contentLength,
      uploadSourceFileName: input.fileName, uploadSourceContentType: input.contentType,
      reservationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).onConflictDoNothing({
      target: [videosTable.organizationId, videosTable.uploadIdempotencyKey],
    }).returning();
    if (!video) {
      const [concurrent] = await tx.select().from(videosTable).where(and(
        eq(videosTable.organizationId, req.tenant.organizationId),
        eq(videosTable.uploadIdempotencyKey, idempotencyKey),
      )).limit(1);
      if (!concurrent) throw new Error("Idempotent upload reservation disappeared");
      return { video: concurrent, newlyReserved: false };
    }
    // Reserve the declared bytes while the provider outcome is pending. This
    // prevents concurrent init calls from exceeding the storage entitlement.
    await tx.update(organizationsTable).set({
      storageUsedBytes: sql`${organizationsTable.storageUsedBytes} + ${input.contentLength}`,
    }).where(eq(organizationsTable.id, req.tenant.organizationId));
    return { video, newlyReserved: true };
  }).catch((error: unknown) => {
    if (error instanceof UploadInputError) return { error: error.message };
    if (error instanceof UploadReplayBlockedError) return { blocked: error.message };
    throw error;
  });
  if ("error" in reservation) {
    res.status(403).json({ error: reservation.error });
    return;
  }
  if ("blocked" in reservation) {
    res.status(409).json({ error: reservation.blocked });
    return;
  }

  let providerAssetId = reservation.video.providerAssetId;
  let assetCreationAttempted = false;
  let assetPersisted = Boolean(providerAssetId);
  if (reservation.video.reconciliationRequired) {
    res.status(409).json({ error: "Upload requires provider reconciliation before it can continue." });
    return;
  }
  const claim = providerAssetId ? undefined : randomUUID();
  if (claim) {
    const [claimed] = await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      assetCreationClaim: claim, assetCreationClaimedAt: new Date(),
    }).where(and(
      scopedVideoWhere(req.tenant.organizationId, reservation.video.id),
      sql`${videosTable.providerAssetId} is null`,
      sql`${videosTable.assetCreationClaim} is null`,
    )).returning({ id: videosTable.id }));
    if (!claimed) {
      res.status(409).json({ error: "Upload initialization is in progress; retry with the same idempotency key." });
      return;
    }
  }
  try {
    // The deterministic adapter is only selected in NODE_ENV=test. Production
    // always constructs the configured account-backed Bunny adapter.
    const provider = process.env.NODE_ENV === "test"
      ? videoProviders.resolve("step7-smoke")
      : await resolveProvisioningProvider(spaceData.account, spaceData.space);
    if (!providerAssetId) {
      assetCreationAttempted = true;
      const asset = await provider.createAsset({ id: spaceData.space.providerSpaceId }, { title: input.title });
      providerAssetId = asset.id;
      const [linked] = await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
        providerAccountId: spaceData.account.id, providerTenantSpaceId: spaceData.space.providerSpaceId!,
        providerAssetId: asset.id, assetCreationClaim: null, assetCreationClaimedAt: null,
      }).where(and(scopedVideoWhere(req.tenant.organizationId, reservation.video.id), eq(videosTable.assetCreationClaim, claim!)))
        .returning({ id: videosTable.id }));
      if (!linked) throw new Error("Provider asset was created but its local linkage could not be confirmed");
      assetPersisted = true;
    }
    const credentials = await provider.getUploadCredentials(
      { id: spaceData.space.providerSpaceId }, { id: providerAssetId },
      { fileName: input.fileName, contentType: input.contentType, contentLength: input.contentLength },
    );
    await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      status: "uploading", uploadFailureDetail: null, initializationRetryable: false,
    })
      .where(scopedVideoWhere(req.tenant.organizationId, reservation.video.id)));
    // Do not expose the stored provider linkage; only transient upload headers
    // and the owned video UUID leave this endpoint.
    res.status(reservation.newlyReserved ? 201 : 200).json(InitializeVideoUploadResponse.parse({
      videoId: reservation.video.id, upload: credentials,
    }));
  } catch (error) {
    if (error instanceof AssetCreationRejectedError && assetCreationAttempted) {
      await withTenantDb(req.tenant, async (tx) => {
        await releaseReservationInTransaction(tx, req.tenant.organizationId, reservation.video.id);
        await tx.delete(videosTable).where(scopedVideoWhere(req.tenant.organizationId, reservation.video.id));
      });
      res.status(502).json({ error: "Video provider rejected asset creation. Please try again." });
      return;
    }
    if (!assetCreationAttempted || assetPersisted) {
      await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
        status: "error",
        uploadFailureDetail: assetPersisted
          ? "Upload credentials are temporarily unavailable; retry with the same idempotency key."
          : "Provider setup is temporarily unavailable; retry with the same idempotency key.",
        assetCreationClaim: null,
        assetCreationClaimedAt: null,
        initializationRetryable: true,
      }).where(scopedVideoWhere(req.tenant.organizationId, reservation.video.id)));
      req.log.error({ err: error, videoId: reservation.video.id }, "Retryable upload initialization failure");
      res.status(503).json({ error: "Upload initialization is temporarily unavailable. Retry with the same idempotency key." });
      return;
    }
    await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      status: "error", uploadFailureDetail: "Provider outcome is unknown and requires reconciliation.",
      reconciliationRequired: "provider asset creation outcome unknown",
      initializationRetryable: false,
    }).where(scopedVideoWhere(req.tenant.organizationId, reservation.video.id)));
    req.log.error({ err: error, videoId: reservation.video.id }, "Upload initialization outcome is ambiguous");
    res.status(503).json({ error: "Upload initialization could not be confirmed. Retry with the same idempotency key." });
  }
});

router.post("/videos/:videoId/upload-complete", requirePermission("videos.create"), async (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [updated] = await tx.update(videosTable).set({
      status: "processing", reservationExpiresAt: null, reservedBytes: 0, quotaReleasedAt: new Date(),
      initializationRetryable: false,
    })
      .where(and(scopedVideoWhere(req.tenant.organizationId, videoId), eq(videosTable.status, "uploading")))
      .returning({ id: videosTable.id });
    return updated ? readVideo(tx, req.tenant.organizationId, videoId) : undefined;
  });
  if (!video) {
    res.status(409).json({ error: "This upload cannot be acknowledged in its current state." });
    return;
  }
  // Byte transfer completion is not a ready signal; only the future webhook
  // flow may transition processing to ready/error.
  res.json(video);
});

router.post("/videos/:videoId/upload-cancel", requirePermission("videos.create"), async (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select().from(videosTable).where(scopedVideoWhere(req.tenant.organizationId, videoId)).limit(1);
    return row;
  });
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  try {
    if (video.providerAssetId && video.providerTenantSpaceId && video.providerAccountId) {
      const spaceData = await withTenantDb(req.tenant, async (tx) => {
        const [row] = await tx.select({ space: providerTenantSpacesTable, account: providerAccountsTable })
          .from(providerTenantSpacesTable).innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
          .where(and(eq(providerTenantSpacesTable.organizationId, req.tenant.organizationId), eq(providerTenantSpacesTable.providerAccountId, video.providerAccountId!))).limit(1);
        return row;
      });
      if (!spaceData?.space.providerSpaceId) throw new Error("Provider space is unavailable");
      const provider = process.env.NODE_ENV === "test" ? videoProviders.resolve("step7-smoke")
        : await resolveProvisioningProvider(spaceData.account, spaceData.space);
      await provider.deleteAsset({ id: video.providerTenantSpaceId }, { id: video.providerAssetId });
    }
    const cancelled = await withTenantDb(req.tenant, async (tx) => {
      await releaseReservationInTransaction(tx, req.tenant.organizationId, videoId);
      await tx.update(videosTable).set({
        status: "error", uploadFailureDetail: "Upload cancelled", initializationRetryable: false,
      })
        .where(scopedVideoWhere(req.tenant.organizationId, videoId));
      return readVideo(tx, req.tenant.organizationId, videoId);
    });
    res.json(cancelled);
  } catch (error) {
    await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      status: "error", reconciliationRequired: "provider deletion outcome unknown",
      uploadFailureDetail: "Cancellation requires provider reconciliation.",
      initializationRetryable: false,
    }).where(scopedVideoWhere(req.tenant.organizationId, videoId)));
    req.log.error({ err: error, videoId }, "Upload cancellation outcome is ambiguous");
    res.status(503).json({ error: "Cancellation could not be confirmed and requires reconciliation." });
  }
});

class UploadInputError extends Error {}
class UploadReplayBlockedError extends Error {}

function isRetryableInitializationRecord(status: (typeof videoStatuses)[number], initializationRetryable: boolean) {
  return status === "created" || status === "uploading" || initializationRetryable;
}

function numericLimit(value: boolean | number | string) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isAllowedUpload(fileName: string, contentType: string) {
  return /^[\w .()\-]{1,255}$/.test(fileName)
    && /^video\/(?:mp4|quicktime|webm|x-matroska|mpeg)$/i.test(contentType);
}

/** Releases a reservation at most once; callers must be in the tenant transaction. */
async function releaseReservationInTransaction(tx: TenantTransaction, organizationId: string, videoId: string) {
  const [video] = await tx.select({
    reservedBytes: videosTable.reservedBytes, quotaReleasedAt: videosTable.quotaReleasedAt,
  }).from(videosTable).where(scopedVideoWhere(organizationId, videoId)).limit(1);
  if (!video || video.quotaReleasedAt || !video.reservedBytes) return false;
  const [released] = await tx.update(videosTable).set({ quotaReleasedAt: new Date() })
    .where(and(scopedVideoWhere(organizationId, videoId), sql`${videosTable.quotaReleasedAt} is null`))
    .returning({ id: videosTable.id });
  if (!released) return false;
  await tx.update(organizationsTable).set({
    storageUsedBytes: sql`greatest(0, ${organizationsTable.storageUsedBytes} - ${video.reservedBytes})`,
  }).where(eq(organizationsTable.id, organizationId));
  return true;
}

router.get("/videos/:videoId", requirePermission("videos.read"), async (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const video = await withTenantDb(req.tenant, (tx) => readVideo(tx, req.tenant.organizationId, videoId));
  if (!video) return void res.status(404).json({ error: "Video not found" });
  res.json(GetVideoResponse.parse(video));
});

router.patch("/videos/:videoId", requirePermission("videos.update"), async (req, res) => {
  const { videoId } = UpdateVideoParams.parse(req.params);
  const update = UpdateVideoBody.parse(req.body);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [updated] = await tx.update(videosTable).set(update)
      .where(scopedVideoWhere(req.tenant.organizationId, videoId))
      .returning({ id: videosTable.id });
    if (!updated) return undefined;
    return readVideo(tx, req.tenant.organizationId, videoId);
  });
  if (!video) return void res.status(404).json({ error: "Video not found" });
  res.json(UpdateVideoResponse.parse(video));
});

router.get("/activity", async (req, res) => {
  const activity = await withTenantDb(req.tenant, (tx) => tx.select({
    id: auditLogsTable.id,
    action: auditLogsTable.action,
    subject: auditLogsTable.subjectLabel,
    actor: usersTable.name,
    createdAt: auditLogsTable.createdAt,
  }).from(auditLogsTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorUserId))
    .where(eq(auditLogsTable.organizationId, req.tenant.organizationId))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(10));
  res.json(ListActivityResponse.parse(activity.map((item) => ({ ...item, actor: item.actor ?? "System" }))));
});

export default router;