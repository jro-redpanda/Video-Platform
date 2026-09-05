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
  CreatePlaybackAnalyticsGrantBody,
  CreatePlaybackAnalyticsGrantParams,
  CreatePlaybackAnalyticsGrantResponse,
  CreatePlaybackEventsBody,
  CreatePlaybackEventsResponse,
  GetPublicVideoParams,
  GetPublicVideoResponse,
} from "@workspace/api-zod";
import { resolveProvisioningProvider } from "../lib/provider-registry";
import { getThumbnailStorage, ThumbnailObjectNotFoundError } from "../lib/thumbnail-storage";
import { streamThumbnail } from "./thumbnails";
import {
  AnalyticsHttpError,
  consumeGrantIssueLimit,
  ingestPlaybackEvents,
  issueAnalyticsGrant,
} from "../lib/playback-analytics";
import { setPlaybackResponsePolicy, validatePlaybackSource } from "../lib/playback-sources";

const router: IRouter = Router();

router.get("/runtime-config", (_req, res) => {
  res.json(GetRuntimeConfigResponse.parse(runtimeConfig));
});

router.get("/videos/:videoId/source", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  setPlaybackResponsePolicy(res);
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
    const provider = await resolveProvisioningProvider(linkage.account, linkage.space);
    const sources = await provider.getPlaybackSources(
      { id: linkage.providerTenantSpaceId },
      { id: linkage.providerAssetId },
    );
    const source = await validatePlaybackSource(
      provider,
      { id: linkage.providerTenantSpaceId },
      { id: linkage.providerAssetId },
      sources,
    );
    const [stillEligible] = await db.select({ id: videosTable.id }).from(videosTable).where(and(
      eq(videosTable.id, videoId),
      eq(videosTable.status, "ready"),
      ne(videosTable.visibility, "private"),
      eq(videosTable.providerAccountId, linkage.account.id),
      eq(videosTable.providerTenantSpaceId, linkage.providerTenantSpaceId),
      eq(videosTable.providerAssetId, linkage.providerAssetId),
    )).limit(1);
    if (!stillEligible) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    // The provider attests this asset-bound URL above, then eligibility is rechecked after I/O.
    res.status(307).setHeader("Location", source.sourceUrl).end(); // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source redirect resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.get("/videos/:videoId/thumbnail", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
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
    }, true, (error, headersSent) => {
      req.log.error({ err: error, videoId, headersSent }, "Public thumbnail stream failed");
    });
  } catch (error) {
    res.removeHeader("Content-Length");
    res.setHeader("Cache-Control", "private, no-store");
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
  setPlaybackResponsePolicy(res);
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
  const metadata = {
    ...rest,
    thumbnailUrl,
    posterUrl: thumbnailUrl,
  };
  if (video.status !== "ready") {
    res.json(GetPublicVideoResponse.parse(metadata));
    return;
  }
  if (!providerAssetId || !providerTenantSpaceId || !account || !space) {
    req.log.error({ videoId }, "Ready video has incomplete provider linkage");
    res.status(503).json({ error: "Playback source is unavailable" });
    return;
  }
  try {
    const provider = await resolveProvisioningProvider(account, space);
    const sources = await provider.getPlaybackSources({ id: providerTenantSpaceId }, { id: providerAssetId });
    const source = await validatePlaybackSource(
      provider,
      { id: providerTenantSpaceId },
      { id: providerAssetId },
      sources,
    );
    const [stillEligible] = await db.select({ id: videosTable.id }).from(videosTable).where(and(
      eq(videosTable.id, videoId),
      eq(videosTable.status, "ready"),
      ne(videosTable.visibility, "private"),
      eq(videosTable.providerAccountId, account.id),
      eq(videosTable.providerTenantSpaceId, providerTenantSpaceId),
      eq(videosTable.providerAssetId, providerAssetId),
    )).limit(1);
    if (!stillEligible) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    res.json(GetPublicVideoResponse.parse({
      ...metadata,
      sourceUrl: `/api/public/videos/${videoId}/source`,
      sourceType: "hls",
      sourceExpiresAt: source.expiresAt.toISOString(),
      posterUrl: metadata.thumbnailUrl,
    }));
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.post("/videos/:videoId/analytics-grant", async (req, res): Promise<void> => {
  const params = CreatePlaybackAnalyticsGrantParams.safeParse(req.params);
  const body = CreatePlaybackAnalyticsGrantBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid playback analytics grant request" });
    return;
  }
  const [active] = await db.select({
    organizationId: videosTable.organizationId,
    embedId: videoEmbedsTable.videoId,
    generation: videoEmbedsTable.generationVersion,
  }).from(videosTable)
    .innerJoin(videoEmbedsTable, eq(videoEmbedsTable.videoId, videosTable.id))
    .where(and(
      eq(videosTable.id, params.data.videoId),
      eq(videosTable.status, "ready"),
      ne(videosTable.visibility, "private"),
      eq(videoEmbedsTable.generationStatus, "generated"),
    ))
    .limit(1);
  if (!active) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  try {
    await consumeGrantIssueLimit(active.organizationId, params.data.videoId, req.ip ?? "unknown");
    const issued = issueAnalyticsGrant({
      organizationId: active.organizationId,
      videoId: params.data.videoId,
      embedId: active.embedId,
      generation: active.generation,
      sessionId: body.data.sessionId,
    });
    res.status(201).json(CreatePlaybackAnalyticsGrantResponse.parse({
      grant: issued.grant,
      expiresAt: issued.expiresAt.toISOString(),
    }));
  } catch (error) {
    if (error instanceof AnalyticsHttpError) {
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      res.status(error.status).json({ error: "Playback analytics grant rejected", code: error.code });
      return;
    }
    throw error;
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