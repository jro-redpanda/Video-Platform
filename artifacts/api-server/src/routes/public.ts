import { and, eq, inArray, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { runtimeConfig } from "../lib/config";
import { GetRuntimeConfigResponse } from "@workspace/api-zod";
import {
  db,
  organizationCustomizationTable,
  playbackEventsTable,
  videosTable,
} from "@workspace/db";
import {
  CreatePlaybackEventsBody,
  CreatePlaybackEventsResponse,
  GetPublicVideoParams,
  GetPublicVideoResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/runtime-config", (_req, res) => {
  res.json(GetRuntimeConfigResponse.parse(runtimeConfig));
});

// PRELIMINARY SCAFFOLDING: replace this public playback surface at Step 11.
// MOCK: replaced at step 11

router.get("/videos/:videoId", async (req, res) => {
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
  }).from(videosTable)
    .innerJoin(
      organizationCustomizationTable,
      eq(organizationCustomizationTable.organizationId, videosTable.organizationId),
    )
    .where(and(
      eq(videosTable.id, videoId),
      ne(videosTable.visibility, "private"),
    ))
    .limit(1);

  if (!video) return void res.status(404).json({ error: "Video not found" });
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(GetPublicVideoResponse.parse(video));
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