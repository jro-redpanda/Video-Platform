import { and, eq, inArray, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { runtimeConfig } from "../lib/config";
import { GetRuntimeConfigResponse } from "@workspace/api-zod";
import {
  db,
  organizationCustomizationTable,
  playbackEventsTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
} from "@workspace/db";
import {
  CreatePlaybackEventsBody,
  CreatePlaybackEventsResponse,
  GetPublicVideoParams,
  GetPublicVideoResponse,
} from "@workspace/api-zod";
import { resolveProvisioningProvider, videoProviders } from "../lib/provider-registry";

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
    res.setHeader("Cache-Control", "private, no-store");
    res.redirect(307, sources.hlsUrl);
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source redirect resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.get("/videos/:videoId", async (req, res): Promise<void> => {
  const { videoId } = GetPublicVideoParams.parse(req.params);
  const [video] = await db.select({
    id: videosTable.id,
    title: videosTable.title,
    description: videosTable.description,
    status: videosTable.status,
    visibility: videosTable.visibility,
    durationSeconds: videosTable.durationSeconds,
    thumbnailColor: videosTable.thumbnailColor,
    playerAccent: organizationCustomizationTable.playerAccent,
    playerControlForeground: organizationCustomizationTable.playerControlForeground,
    playerControlBackground: organizationCustomizationTable.playerControlBackground,
    posterTreatment: organizationCustomizationTable.posterTreatment,
    providerAssetId: videosTable.providerAssetId,
    providerTenantSpaceId: videosTable.providerTenantSpaceId,
    account: providerAccountsTable,
    space: providerTenantSpacesTable,
  }).from(videosTable)
    .innerJoin(
      organizationCustomizationTable,
      eq(organizationCustomizationTable.organizationId, videosTable.organizationId),
    )
    .leftJoin(providerAccountsTable, eq(providerAccountsTable.id, videosTable.providerAccountId))
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
  const { providerAssetId, providerTenantSpaceId, account, space, ...metadata } = video;
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
    res.setHeader("Cache-Control", "private, no-store");
    res.json(GetPublicVideoResponse.parse({
      ...metadata,
      sourceUrl: `/api/public/videos/${videoId}/source`,
      sourceType: "hls",
      sourceExpiresAt: expiry.toISOString(),
      posterUrl: null,
    }));
  } catch (error) {
    req.log.error({ err: error, videoId }, "Playback source resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

// PRELIMINARY SCAFFOLDING: replace this beacon ingestion at Step 16.
// MOCK: replaced at step 16
router.post("/playback-events", async (req, res) => {
  const { events } = CreatePlaybackEventsBody.parse(req.body);
  const videoIds = [...new Set(events.map((event) => event.videoId))];
  const visibleVideos = await db.select({
    id: videosTable.id,
    organizationId: videosTable.organizationId,
  }).from(videosTable).where(and(
    inArray(videosTable.id, videoIds),
    ne(videosTable.visibility, "private"),
  ));
  const organizationsByVideo = new Map(visibleVideos.map((video) => [video.id, video.organizationId]));
  const accepted = events.filter((event) => organizationsByVideo.has(event.videoId));

  if (accepted.length) {
    await db.insert(playbackEventsTable).values(accepted.map((event) => ({
      organizationId: organizationsByVideo.get(event.videoId)!,
      videoId: event.videoId,
      sessionId: event.sessionId,
      eventType: event.eventType,
      positionSeconds: event.positionSeconds,
      occurredAt: new Date(event.occurredAt),
    })));
  }

  res.status(202).json(CreatePlaybackEventsResponse.parse({ accepted: accepted.length }));
});

export default router;