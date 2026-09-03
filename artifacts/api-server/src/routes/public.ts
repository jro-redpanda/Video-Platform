import { and, eq, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { runtimeConfig } from "../lib/config";
import { GetRuntimeConfigResponse } from "@workspace/api-zod";
import {
  db,
  organizationCustomizationTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
  videoEmbedsTable,
} from "@workspace/db";
import {
  CreatePlaybackEventsBody,
  CreatePlaybackEventsResponse,
  GetPublicVideoParams,
  GetPublicVideoResponse,
} from "@workspace/api-zod";
import { resolveProvisioningProvider, videoProviders } from "../lib/provider-registry";
import { getThumbnailStorage, ThumbnailObjectNotFoundError } from "../lib/thumbnail-storage";
import { streamThumbnail } from "./thumbnails";
import {
  AnalyticsHttpError,
  consumeGrantIssueLimit,
  ingestPlaybackEvents,
  issueAnalyticsGrant,
} from "../lib/playback-analytics";

const router: IRouter = Router();

router.get("/runtime-config", (_req, res) => {
  res.json(GetRuntimeConfigResponse.parse(runtimeConfig));
});

router.get("/videos/:videoId/source", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  const [linkage] = await db.select({
    status: videosTable.status,
    providerAssetId: videosTable.providerAssetId,
    providerTenantSpaceId: videosTable.providerTenantSpaceId,
    account: providerAccountsTable,
    space: providerTenantSpacesTable,
  }).from(videosTable)
    .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, videosTable.providerAccountId))
    .innerJoin(providerTenantSpacesTable, and(
      eq(providerTenantSpacesTable.organizationId, videosTable.organizationId),
      eq(providerTenantSpacesTable.providerAccountId, videosTable.providerAccountId),
      eq(providerTenantSpacesTable.providerSpaceId, videosTable.providerTenantSpaceId),
    ))
    .where(and(
      eq(videosTable.id, videoId),
      eq(videosTable.status, "ready"),
      ne(videosTable.visibility, "private"),
    ))
    .limit(1);
  if (!linkage?.providerAssetId || !linkage.providerTenantSpaceId) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  try {
    const provider = process.env.NODE_ENV === "test"
      ? videoProviders.resolve(linkage.account.providerKey)
      : await resolveProvisioningProvider(linkage.account, linkage.space);
    const sources = await provider.getPlaybackSources(
      { id: linkage.providerTenantSpaceId },
      { id: linkage.providerAssetId },
    );
    if (!sources.hlsUrl || new Date(sources.expiresAt).getTime() <= Date.now()) {
      throw new Error("Provider returned no current maintained playback source");
    }
    const sourceUrl = new URL(sources.hlsUrl).toString();
    if (!await provider.isPlaybackSourceTrusted({ id: linkage.providerTenantSpaceId }, sourceUrl)) {
      throw new Error("Provider returned an untrusted playback source");
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(307).setHeader("Location", sourceUrl).end();
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source redirect resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.get("/videos/:videoId/thumbnail", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  const [thumbnail] = await db.select({
    objectKey: videosTable.thumbnailObjectKey,
    contentType: videosTable.thumbnailContentType,
    sizeBytes: videosTable.thumbnailSizeBytes,
    version: videosTable.thumbnailVersion,
    generation: videosTable.thumbnailGeneration,
    mutableUntil: videosTable.thumbnailMutableUntil,
  }).from(videosTable).where(and(
    eq(videosTable.id, videoId),
    ne(videosTable.visibility, "private"),
  )).limit(1);
  if (!thumbnail?.objectKey || !thumbnail.contentType || !thumbnail.sizeBytes || !thumbnail.version
    || (thumbnail.mutableUntil && thumbnail.mutableUntil.getTime() > Date.now())
    || req.query.v !== thumbnail.version) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }
  const objectStorage = getThumbnailStorage(req.app.locals);
  try {
    const actual = await objectStorage.getMetadata(thumbnail.objectKey, thumbnail.generation ?? undefined);
    if (actual.contentType !== thumbnail.contentType || actual.size !== thumbnail.sizeBytes) {
      throw new Error("Stored thumbnail metadata changed after finalization");
    }
    if (thumbnail.generation && actual.generation !== thumbnail.generation) {
      throw new Error("Stored thumbnail generation changed after finalization");
    }
    streamThumbnail(res, objectStorage, {
      objectKey: thumbnail.objectKey,
      contentType: thumbnail.contentType,
      sizeBytes: thumbnail.sizeBytes,
      generation: thumbnail.generation ?? undefined,
    }, true);
  } catch (error) {
    if (error instanceof ThumbnailObjectNotFoundError) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }
    req.log.error({ err: error, videoId }, "Public thumbnail serving failed");
    res.status(503).json({ error: "Thumbnail storage is unavailable" });
  }
});

router.get("/videos/:videoId", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  const [video] = await db.select({
    id: videosTable.id,
    organizationId: videosTable.organizationId,
    title: videosTable.title,
    description: videosTable.description,
    status: videosTable.status,
    visibility: videosTable.visibility,
    durationSeconds: videosTable.durationSeconds,
    thumbnailColor: videosTable.thumbnailColor,
    thumbnailObjectKey: videosTable.thumbnailObjectKey,
    thumbnailVersion: videosTable.thumbnailVersion,
    thumbnailMutableUntil: videosTable.thumbnailMutableUntil,
    playerAccent: organizationCustomizationTable.playerAccent,
    playerControlForeground: organizationCustomizationTable.playerControlForeground,
    playerControlBackground: organizationCustomizationTable.playerControlBackground,
    posterTreatment: organizationCustomizationTable.posterTreatment,
    providerAssetId: videosTable.providerAssetId,
    providerTenantSpaceId: videosTable.providerTenantSpaceId,
    account: providerAccountsTable,
    space: providerTenantSpacesTable,
    embedId: videoEmbedsTable.videoId,
    embedGeneration: videoEmbedsTable.generationVersion,
    embedStatus: videoEmbedsTable.generationStatus,
  }).from(videosTable)
    .innerJoin(
      organizationCustomizationTable,
      eq(organizationCustomizationTable.organizationId, videosTable.organizationId),
    )
    .leftJoin(providerAccountsTable, eq(providerAccountsTable.id, videosTable.providerAccountId))
    .leftJoin(videoEmbedsTable, eq(videoEmbedsTable.videoId, videosTable.id))
    .leftJoin(providerTenantSpacesTable, and(
      eq(providerTenantSpacesTable.organizationId, videosTable.organizationId),
      eq(providerTenantSpacesTable.providerAccountId, videosTable.providerAccountId),
      eq(providerTenantSpacesTable.providerSpaceId, videosTable.providerTenantSpaceId),
    ))
    .where(and(
      eq(videosTable.id, videoId),
      ne(videosTable.visibility, "private"),
    ))
    .limit(1);

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  const {
    providerAssetId, providerTenantSpaceId, account, space, thumbnailObjectKey, thumbnailVersion,
    thumbnailMutableUntil, organizationId, embedId, embedGeneration, embedStatus, ...rest
  } = video;
  const thumbnailUrl = thumbnailObjectKey && thumbnailVersion
    && (!thumbnailMutableUntil || thumbnailMutableUntil.getTime() <= Date.now())
    ? `/api/public/videos/${videoId}/thumbnail?v=${thumbnailVersion}` : null;
  let analytics: ReturnType<typeof issueAnalyticsGrant> | undefined;
  if (embedId && embedGeneration && embedStatus === "generated") {
    try {
      await consumeGrantIssueLimit(organizationId, videoId, req.ip ?? "unknown");
      analytics = issueAnalyticsGrant({ organizationId, videoId, embedId, generation: embedGeneration });
    } catch (error) {
      if (error instanceof AnalyticsHttpError) {
        if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
        res.status(error.status).json({ error: "Playback analytics request rejected", code: error.code });
        return;
      }
      throw error;
    }
  }
  const metadata = {
    ...rest,
    thumbnailUrl,
    posterUrl: thumbnailUrl,
    ...(analytics ? {
      analyticsGrant: analytics.grant,
      analyticsGrantExpiresAt: analytics.expiresAt.toISOString(),
    } : {}),
  };
  if (video.status !== "ready") {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(GetPublicVideoResponse.parse(metadata));
    return;
  }
  if (!providerAssetId || !providerTenantSpaceId || !account || !space) {
    req.log.error({ videoId }, "Ready video has incomplete provider linkage");
    res.status(503).json({ error: "Playback source is unavailable" });
    return;
  }
  try {
    const provider = process.env.NODE_ENV === "test"
      ? videoProviders.resolve(account.providerKey)
      : await resolveProvisioningProvider(account, space);
    const sources = await provider.getPlaybackSources({ id: providerTenantSpaceId }, { id: providerAssetId });
    const sourceUrl = sources.hlsUrl;
    if (!sourceUrl) throw new Error("Provider returned no maintained playback source");
    const expiry = new Date(sources.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw new Error("Provider returned an expired playback source");
    }
    const normalizedSourceUrl = new URL(sourceUrl).toString();
    if (!await provider.isPlaybackSourceTrusted({ id: providerTenantSpaceId }, normalizedSourceUrl)) {
      throw new Error("Provider returned an untrusted playback source");
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(GetPublicVideoResponse.parse({
      ...metadata,
      sourceUrl: `/api/public/videos/${videoId}/source`,
      sourceType: "hls",
      sourceExpiresAt: expiry.toISOString(),
      posterUrl: metadata.thumbnailUrl,
    }));
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.post("/playback-events", async (req, res) => {
  const parsed = CreatePlaybackEventsBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid playback event batch", code: "invalid_event_batch" });
  try {
    const result = await ingestPlaybackEvents({
      grant: parsed.data.grant,
      events: parsed.data.events,
      ip: req.ip ?? "unknown",
    });
    res.status(202).json(CreatePlaybackEventsResponse.parse(result));
  } catch (error) {
    if (error instanceof AnalyticsHttpError) {
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      return void res.status(error.status).json({ error: "Playback analytics request rejected", code: error.code });
    }
    throw error;
  }
});

export default router;