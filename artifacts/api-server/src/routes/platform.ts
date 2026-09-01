import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { runtimeConfig } from "../lib/config";
import {
  auditLogsTable,
  membershipsTable,
  organizationCustomizationTable,
  organizationsTable,
  plansTable,
  usersTable,
  videoAnalyticsRollupsTable,
  videosTable,
} from "@workspace/db";
import {
  CreateVideoBody,
  CreateVideoResponse,
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
} from "@workspace/api-zod";
import { withTenantDb, type TenantTransaction } from "../lib/tenant-db";
import { requirePermission } from "../lib/permissions";

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
  const workspace = await withTenantDb(req.tenant, async (tx) => {
    const [record] = await tx.select({
    id: organizationsTable.id,
    name: organizationsTable.name,
    slug: organizationsTable.slug,
    plan: plansTable.name,
    memberCount: sql<number>`count(distinct ${membershipsTable.id})::int`,
    storageUsedGb: sql<number>`${organizationsTable.storageUsedBytes}::float / 1073741824`,
    storageLimitGb: plansTable.storageLimitGb,
    playerAccent: organizationCustomizationTable.playerAccent,
    logoInitials: organizationCustomizationTable.logoInitials,
  }).from(organizationsTable)
    .innerJoin(plansTable, eq(plansTable.id, organizationsTable.planId))
    .innerJoin(organizationCustomizationTable, eq(organizationCustomizationTable.organizationId, organizationsTable.id))
    .leftJoin(membershipsTable, eq(membershipsTable.organizationId, organizationsTable.id))
    .where(eq(organizationsTable.id, req.tenant.organizationId))
      .groupBy(organizationsTable.id, plansTable.id, organizationCustomizationTable.organizationId);
    return record;
  });

  if (!workspace) return void res.status(404).json({ error: "Workspace not found" });
  res.json(GetWorkspaceResponse.parse(workspace));
});

router.patch("/workspace", requirePermission("workspace.manage"), async (req, res) => {
  const update = UpdateWorkspaceBody.parse(req.body);
  const response = await withTenantDb(req.tenant, async (tx) => {
    if (update.name) {
      await tx.update(organizationsTable).set({ name: update.name }).where(eq(organizationsTable.id, req.tenant.organizationId));
    }
    if (update.playerAccent || update.logoInitials) {
      await tx.update(organizationCustomizationTable).set({
        ...(update.playerAccent ? { playerAccent: update.playerAccent } : {}),
        ...(update.logoInitials ? { logoInitials: update.logoInitials } : {}),
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
    logoInitials: organizationCustomizationTable.logoInitials,
  }).from(organizationsTable)
    .innerJoin(plansTable, eq(plansTable.id, organizationsTable.planId))
    .innerJoin(organizationCustomizationTable, eq(organizationCustomizationTable.organizationId, organizationsTable.id))
    .leftJoin(membershipsTable, eq(membershipsTable.organizationId, organizationsTable.id))
    .where(eq(organizationsTable.id, organizationId))
    .groupBy(organizationsTable.id, plansTable.id, organizationCustomizationTable.organizationId);
  return workspace;
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

// MOCK: replaced at step 9
router.post("/videos", requirePermission("videos.create"), async (req, res) => {
  const input = CreateVideoBody.parse(req.body);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [created] = await tx.insert(videosTable).values({
      organizationId: req.tenant.organizationId,
      title: input.title,
      description: input.description ?? "",
      status: "uploading",
    }).returning({ id: videosTable.id });
    return readVideo(tx, req.tenant.organizationId, created.id);
  });
  res.status(201).json(CreateVideoResponse.parse(video));
});

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