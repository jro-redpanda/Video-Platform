import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { runtimeConfig } from "../lib/config";
import {
  auditLogsTable,
  embedGenerationOutboxTable,
  foldersTable,
  groupPermissionsTable,
  membershipsTable,
  masterStorageOperationsTable,
  organizationCustomizationTable,
  objectCleanupOutboxTable,
  organizationsTable,
  plansTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  thumbnailUploadIntentsTable,
  usersTable,
  videoAnalyticsRollupsTable,
  videoEmbedsTable,
  videoLibrarySnapshotItemsTable,
  videoLibrarySnapshotsTable,
  videosTable,
  webhookEventsTable,
} from "@workspace/db";
import {
  BulkDeleteVideosBody,
  BulkDeleteVideosResponse,
  BulkUpdateVideosBody,
  BulkUpdateVideosResponse,
  GetDashboardResponse,
  GetVideoParams,
  GetVideoResponse,
  GetAuthenticatedVideoPlaybackResponse,
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
  CompleteVideoUploadBody,
  CancelVideoUploadBody,
} from "@workspace/api-zod";
import { withTenantDb, type TenantTransaction } from "../lib/tenant-db";
import { requirePermission } from "../lib/permissions";
import { hasEntitlement, requireCreateAccess, resolveBillingAccess, resolveEntitlements, type EntitlementKey } from "../lib/entitlements";
import { resolveProvisioningProvider } from "../lib/provider-registry";
import { setPlaybackResponsePolicy, validatePlaybackSource } from "../lib/playback-sources";
import { AssetCreationRejectedError } from "@workspace/providers";
import { serializeEmbed, trustedRequestOrigin } from "../lib/video-embeds";
import { AuditExportRateLimitError, auditDiff, auditUser, consumeAuditExportLimit, writeAuditEvent } from "../lib/audit";

const router: IRouter = Router();
let beforeAssetCreationClaimForTest:
  ((videoId: string, idempotencyKey: string) => Promise<void>) | undefined;

export function setBeforeAssetCreationClaimForTest(
  hook?: (videoId: string, idempotencyKey: string) => Promise<void>,
) {
  if (process.env.NODE_ENV !== "test") throw new Error("Asset-creation claim seam is test-only");
  beforeAssetCreationClaimForTest = hook;
}

const videoStatuses = ["created", "uploading", "processing", "ready", "error"] as const;
const videoVisibilities = ["private", "unlisted", "public"] as const;
const videoSorts = ["newest", "oldest", "title_asc", "title_desc", "plays_desc"] as const;
type VideoSort = (typeof videoSorts)[number];
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error("SESSION_SECRET is required");
const cursorSigningKey = createHmac("sha256", sessionSecret)
  .update("video-library-cursor:v2")
  .digest();
const cursorLifetimeMs = 15 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auditMachinePattern = /^[a-z][a-z0-9_.-]{0,99}$/;
const auditActorKinds = new Set(["user", "system", "webhook", "job"]);

const videoProjection = {
  id: videosTable.id,
  title: videosTable.title,
  description: videosTable.description,
  status: videosTable.status,
  visibility: videosTable.visibility,
  durationSeconds: videosTable.durationSeconds,
  createdAt: videosTable.createdAt,
  thumbnailColor: videosTable.thumbnailColor,
  thumbnailUrl: sql<string | null>`case when ${videosTable.thumbnailObjectKey} is not null and ${videosTable.thumbnailVersion} is not null
    and (${videosTable.thumbnailMutableUntil} is null or ${videosTable.thumbnailMutableUntil} <= now()) then
    '/api/videos/' || ${videosTable.id}::text || '/thumbnail?v=' || ${videosTable.thumbnailVersion}::text else null end`,
  plays: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)::int`,
  completionRate: sql<number>`coalesce(
    sum(${videoAnalyticsRollupsTable.completionRate} * ${videoAnalyticsRollupsTable.plays})
      / nullif(sum(${videoAnalyticsRollupsTable.plays}), 0),
    0
  )::float`,
  folderId: videosTable.folderId,
  folderName: sql<string | null>`(
    select folder.name from ${foldersTable} folder
    where folder.organization_id = ${videosTable.organizationId} and folder.id = ${videosTable.folderId}
  )`,
  folderPath: sql<Array<{ id: string; name: string }>>`coalesce((
    with recursive folder_path as (
      select folder.id, folder.parent_id, folder.name, 1 as distance
      from ${foldersTable} folder
      where folder.organization_id = ${videosTable.organizationId} and folder.id = ${videosTable.folderId}
      union all
      select parent.id, parent.parent_id, parent.name, folder_path.distance + 1
      from ${foldersTable} parent
      inner join folder_path on folder_path.parent_id = parent.id
      where parent.organization_id = ${videosTable.organizationId}
    )
    select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by distance desc)
    from folder_path
  ), '[]'::jsonb)`,
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
  const workspace = await withTenantDb(req.tenant, (tx) => fetchWorkspace(
    tx, req.tenant.organizationId, req.tenant.userId,
  ));

  if (!workspace) return void res.status(404).json({ error: "Workspace not found" });
  res.json(GetWorkspaceResponse.parse(workspace));
});

// workspace.manage is the Step 4 RBAC permission mapped to workspace branding changes;
// plan access is independently checked below through the entitlement guard path.
router.patch("/workspace", requirePermission("workspace.manage"), async (req, res) => {
  const raw = req.body as Record<string, unknown>;
  if (raw.logoObjectKey !== undefined || raw.watermarkObjectKey !== undefined) {
    return void res.status(400).json({ error: "Direct branding object-key updates are not supported." });
  }
  for (const key of ["playerAccent", "playerControlForeground", "playerControlBackground"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(raw[key]))) {
      return void res.status(400).json({ error: `${key} must be a safe six-digit hex color.` });
    }
  }
  if (raw.logoInitials !== undefined && (
    typeof raw.logoInitials !== "string" || !/^[A-Za-z0-9]{1,3}$/.test(raw.logoInitials)
  )) {
    return void res.status(400).json({ error: "logoInitials must contain one to three letters or numbers." });
  }
  const update = UpdateWorkspaceBody.parse(req.body);
  const changesCustomization = Boolean(
    update.playerAccent !== undefined || update.playerControlForeground !== undefined || update.playerControlBackground !== undefined ||
    update.logoInitials !== undefined || update.posterTreatment !== undefined
  );
  if (changesCustomization) {
    const access = await withTenantDb(req.tenant, (tx) => resolveBillingAccess(tx, req.tenant.organizationId));
    if (!access.canCreate) return void res.status(403).json({
      error: "Billing access is restricted", code: "billing_create_restricted", billingStatus: access.status,
    });
  }
  const entitlementForField: Array<[EntitlementKey, boolean]> = [
    ["branding.player_colors", update.playerAccent !== undefined || update.playerControlForeground !== undefined || update.playerControlBackground !== undefined || update.posterTreatment !== undefined],
    ["branding.logo", update.logoInitials !== undefined],
  ];
  for (const [key, requested] of entitlementForField) {
    if (requested && !await hasEntitlement(req, key)) {
      return void res.status(403).json({ error: `This workspace plan does not include ${key}` });
    }
  }
  if (update.playerControlForeground !== undefined || update.playerControlBackground !== undefined) {
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
    if (update.name !== undefined) {
      await tx.update(organizationsTable).set({ name: update.name }).where(eq(organizationsTable.id, req.tenant.organizationId));
    }
    if (
      update.playerAccent !== undefined || update.playerControlForeground !== undefined || update.playerControlBackground !== undefined ||
      update.logoInitials !== undefined || update.posterTreatment !== undefined
    ) {
      await tx.update(organizationCustomizationTable).set({
        ...(update.playerAccent !== undefined ? { playerAccent: update.playerAccent } : {}),
        ...(update.playerControlForeground !== undefined ? { playerControlForeground: update.playerControlForeground } : {}),
        ...(update.playerControlBackground !== undefined ? { playerControlBackground: update.playerControlBackground } : {}),
        ...(update.logoInitials !== undefined ? { logoInitials: update.logoInitials } : {}),
        ...(update.posterTreatment ? { posterTreatment: update.posterTreatment } : {}),
      }).where(eq(organizationCustomizationTable.organizationId, req.tenant.organizationId));
    }
    // This endpoint only accepts normalized Zod input. Keep the audit payload
    // to operator-facing settings, never storage object keys.
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: "workspace.settings_updated", category: "workspace",
      subject: { type: "organization", id: req.tenant.organizationId, label: update.name ?? runtimeConfig.productName },
      afterState: {
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.playerAccent !== undefined ? { playerAccent: update.playerAccent } : {}),
        ...(update.playerControlForeground !== undefined ? { playerControlForeground: update.playerControlForeground } : {}),
        ...(update.playerControlBackground !== undefined ? { playerControlBackground: update.playerControlBackground } : {}),
        ...(update.logoInitials !== undefined ? { logoInitials: update.logoInitials } : {}),
        ...(update.posterTreatment !== undefined ? { posterTreatment: update.posterTreatment } : {}),
      },
      requestId: String(req.id),
    });
    return fetchWorkspace(tx, req.tenant.organizationId, req.tenant.userId);
  });
  res.json(UpdateWorkspaceResponse.parse(response));
});

async function fetchWorkspace(tx: TenantTransaction, organizationId: string, userId: string) {
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
    hasLogoAsset: sql<boolean>`${organizationCustomizationTable.logoObjectKey} is not null`,
    hasWatermarkAsset: sql<boolean>`${organizationCustomizationTable.watermarkObjectKey} is not null`,
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
  const permissions = await tx.select({ key: groupPermissionsTable.permissionKey })
    .from(membershipsTable)
    .innerJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, membershipsTable.groupId))
    .where(and(
      eq(membershipsTable.organizationId, organizationId),
      eq(membershipsTable.userId, userId),
      eq(membershipsTable.status, "active"),
    ))
    .orderBy(asc(groupPermissionsTable.permissionKey));
  return {
    ...workspace,
    entitlements: await resolveEntitlements(tx, organizationId),
    billingAccess: await resolveBillingAccess(tx, organizationId),
    permissions: permissions.map(({ key }) => key),
  };
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
  const { totals, topVideos, playsTrend } = await withTenantDb(req.tenant, async (tx) => {
    const today = sql`(now() at time zone 'UTC')::date`;
    const firstDay = sql`${today} - 29`;
    const [totals] = await tx.select({
    totalVideos: sql<number>`count(distinct ${videosTable.id})::int`,
    totalPlays: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.plays}) filter(where ${videoAnalyticsRollupsTable.day} >= ${firstDay}), 0)::int`,
    watchTimeHours: sql<number>`coalesce(sum(${videoAnalyticsRollupsTable.watchTimeSeconds}) filter(where ${videoAnalyticsRollupsTable.day} >= ${firstDay}), 0)::float / 3600`,
    completionRate: sql<number>`coalesce(
      sum(${videoAnalyticsRollupsTable.completions}) filter(where ${videoAnalyticsRollupsTable.day} >= ${firstDay})
      / nullif(sum(${videoAnalyticsRollupsTable.plays}) filter(where ${videoAnalyticsRollupsTable.day} >= ${firstDay}), 0)::float, 0)`,
  }).from(videosTable)
    .leftJoin(videoAnalyticsRollupsTable, and(
      eq(videoAnalyticsRollupsTable.videoId, videosTable.id),
      sql`${videoAnalyticsRollupsTable.day} >= ${firstDay}`,
    ))
    .where(eq(videosTable.organizationId, organizationId));

    const topVideos = await tx.select(videoProjection).from(videosTable)
    .leftJoin(videoAnalyticsRollupsTable, and(
      eq(videoAnalyticsRollupsTable.videoId, videosTable.id),
      sql`${videoAnalyticsRollupsTable.day} >= ${firstDay}`,
    ))
    .where(eq(videosTable.organizationId, organizationId))
    .groupBy(videosTable.id)
    .orderBy(desc(sql`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)`))
    .limit(5);
    const trendResult = await tx.execute<{ date: string; plays: number }>(sql`
      select to_char(days.day, 'YYYY-MM-DD') date, coalesce(sum(rollup.plays),0)::int plays
      from generate_series(${firstDay}, ${today}, interval '1 day') days(day)
      left join ${videoAnalyticsRollupsTable} rollup on rollup.organization_id=${organizationId}
        and rollup.day=days.day::date
      group by days.day order by days.day
    `);
    return { totals, topVideos, playsTrend: trendResult.rows };
  });

  res.json(GetDashboardResponse.parse({
    ...totals,
    playsTrend,
    topVideos,
  }));
});

router.get("/videos", requirePermission("videos.read"), async (req, res) => {
  const parsedQuery = ListVideosQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: "Invalid video library query parameters." });
    return;
  }
  const query = parsedQuery.data;
  const search = query.search?.trim() || undefined;
  const sort: VideoSort = query.sort ?? "newest";
  const limit = query.limit ?? 24;
  const conditions = [eq(videosTable.organizationId, req.tenant.organizationId)];
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(or(
      sql`${videosTable.title} ilike ${pattern} escape '\'`,
      sql`${videosTable.description} ilike ${pattern} escape '\'`,
    )!);
  }
  if (query.status) conditions.push(eq(videosTable.status, query.status));
  if (query.visibility) conditions.push(eq(videosTable.visibility, query.visibility));
  const folderId = query.folderId === "root" ? null : query.folderId;
  if (folderId !== undefined) {
    if (folderId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(folderId)) {
      res.status(400).json({ error: "folderId must be root or a folder UUID." });
      return;
    }
    if (folderId === null) conditions.push(isNull(videosTable.folderId));
    else conditions.push(eq(videosTable.folderId, folderId));
  }

  const scope: CursorScope = {
    sort, search: search ?? null, status: query.status ?? null, visibility: query.visibility ?? null,
    folderId: folderId ?? (folderId === null ? "root" : null),
  };
  const scopeHash = hashCursorScope(scope, req.tenant.organizationId);
  let cursor: VideoCursor | undefined;
  if (query.cursor) {
    try {
      cursor = decodeVideoCursor(query.cursor, scope, req.tenant.organizationId);
    } catch {
      res.status(400).json({ error: "Malformed or incompatible video cursor." });
      return;
    }
  }

  if (cursor) {
    const page = await withTenantDb(req.tenant, async (tx) => {
      const [snapshot] = await tx.select({
        id: videoLibrarySnapshotsTable.id,
        total: videoLibrarySnapshotsTable.total,
        expiresAt: videoLibrarySnapshotsTable.expiresAt,
      }).from(videoLibrarySnapshotsTable).where(and(
        eq(videoLibrarySnapshotsTable.id, cursor.snapshotId),
        eq(videoLibrarySnapshotsTable.organizationId, req.tenant.organizationId),
        eq(videoLibrarySnapshotsTable.scopeHash, scopeHash),
        gt(videoLibrarySnapshotsTable.expiresAt, new Date()),
      )).limit(1);
      if (!snapshot || snapshot.expiresAt.getTime() !== cursor.expiresAt) return undefined;
      const items = await tx.select({
        position: videoLibrarySnapshotItemsTable.position,
        payload: videoLibrarySnapshotItemsTable.payload,
      }).from(videoLibrarySnapshotItemsTable).where(and(
        eq(videoLibrarySnapshotItemsTable.organizationId, req.tenant.organizationId),
        eq(videoLibrarySnapshotItemsTable.snapshotId, snapshot.id),
        gt(videoLibrarySnapshotItemsTable.position, cursor.position),
      )).orderBy(asc(videoLibrarySnapshotItemsTable.position)).limit(limit + 1);
      return { snapshot, items };
    });
    if (!page) {
      res.status(400).json({ error: "Malformed, expired, or unavailable video cursor." });
      return;
    }
    const hasNext = page.items.length > limit;
    const pageItems = hasNext ? page.items.slice(0, limit) : page.items;
    const tail = pageItems[pageItems.length - 1];
    const nextCursor = hasNext && tail
      ? encodeVideoCursor(
        page.snapshot.id,
        tail.position,
        scope,
        page.snapshot.expiresAt,
        req.tenant.organizationId,
      )
      : null;
    res.json(ListVideosResponse.parse({
      items: pageItems.map(({ payload }) => payload),
      nextCursor,
      total: page.snapshot.total,
    }));
    return;
  }

  const ordering = videoOrdering(sort);
  const result = await withTenantDb(req.tenant, async (tx) => {
    if (folderId) {
      const [folder] = await tx.select({ id: foldersTable.id }).from(foldersTable).where(and(
        eq(foldersTable.organizationId, req.tenant.organizationId), eq(foldersTable.id, folderId),
      )).limit(1);
      if (!folder) return { kind: "missing_folder" as const };
    }
    const probeRows = await tx.select(videoProjection).from(videosTable)
      .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
      .where(and(...conditions))
      .groupBy(videosTable.id)
      .orderBy(...ordering)
      .limit(limit + 1);
    if (probeRows.length <= limit) {
      const items = probeRows.map(freezeVideoListItem);
      return { kind: "page" as const, items, total: items.length, nextCursor: null };
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${req.tenant.organizationId}:video-library-snapshots`}))`);
    const now = new Date();
    await tx.delete(videoLibrarySnapshotsTable).where(and(
      eq(videoLibrarySnapshotsTable.organizationId, req.tenant.organizationId),
      lt(videoLibrarySnapshotsTable.expiresAt, now),
    ));
    const [active] = await tx.select({
      count: sql<number>`count(*)::int`,
    }).from(videoLibrarySnapshotsTable).where(and(
      eq(videoLibrarySnapshotsTable.organizationId, req.tenant.organizationId),
      gt(videoLibrarySnapshotsTable.expiresAt, now),
    ));
    if ((active?.count ?? 0) >= 64) return { kind: "snapshot_limit" as const };

    const rows = await tx.select(videoProjection).from(videosTable)
      .leftJoin(videoAnalyticsRollupsTable, eq(videoAnalyticsRollupsTable.videoId, videosTable.id))
      .where(and(...conditions))
      .groupBy(videosTable.id)
      .orderBy(...ordering);
    const frozenRows = rows.map(freezeVideoListItem);
    if (frozenRows.length <= limit) {
      return { kind: "page" as const, items: frozenRows, total: frozenRows.length, nextCursor: null };
    }

    const snapshotId = randomUUID();
    const expiresAt = new Date(now.getTime() + cursorLifetimeMs);
    await tx.insert(videoLibrarySnapshotsTable).values({
      id: snapshotId,
      organizationId: req.tenant.organizationId,
      scopeHash,
      total: frozenRows.length,
      expiresAt,
    });
    for (let start = 0; start < frozenRows.length; start += 250) {
      await tx.insert(videoLibrarySnapshotItemsTable).values(
        frozenRows.slice(start, start + 250).map((payload, offset) => ({
          snapshotId,
          organizationId: req.tenant.organizationId,
          position: start + offset,
          payload,
        })),
      );
    }
    return {
      kind: "page" as const,
      items: frozenRows.slice(0, limit),
      total: frozenRows.length,
      nextCursor: encodeVideoCursor(snapshotId, limit - 1, scope, expiresAt, req.tenant.organizationId),
    };
  });
  if (result.kind === "missing_folder") {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  if (result.kind === "snapshot_limit") {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Too many active video library snapshots. Please retry shortly." });
    return;
  }
  res.json(ListVideosResponse.parse(result));
});

type CursorScope = {
  sort: VideoSort;
  search: string | null;
  status: (typeof videoStatuses)[number] | null;
  visibility: (typeof videoVisibilities)[number] | null;
  folderId: string | null;
};
type VideoCursor = {
  v: 2;
  scopeHash: string;
  snapshotId: string;
  position: number;
  expiresAt: number;
};

function videoOrdering(sort: VideoSort): SQL[] {
  if (sort === "oldest") return [asc(videosTable.createdAt), asc(videosTable.id)];
  if (sort === "title_asc") return [asc(videosTable.title), asc(videosTable.id)];
  if (sort === "title_desc") return [desc(videosTable.title), desc(videosTable.id)];
  if (sort === "plays_desc") {
    return [desc(sql`coalesce(sum(${videoAnalyticsRollupsTable.plays}), 0)`), desc(videosTable.id)];
  }
  return [desc(videosTable.createdAt), desc(videosTable.id)];
}

function freezeVideoListItem<T extends { createdAt: Date }>(row: T) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function encodeVideoCursor(
  snapshotId: string,
  position: number,
  scope: CursorScope,
  expiresAt: Date,
  organizationId: string,
) {
  const payload = Buffer.from(JSON.stringify({
    v: 2, scopeHash: hashCursorScope(scope, organizationId),
    snapshotId, position, expiresAt: expiresAt.getTime(),
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", cursorSigningKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeVideoCursor(value: string, scope: CursorScope, organizationId: string): VideoCursor {
  const [encodedPayload, encodedSignature, extra] = value.split(".");
  if (extra !== undefined || !encodedPayload || !encodedSignature ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    throw new Error("Invalid cursor encoding");
  }
  const expectedSignature = createHmac("sha256", cursorSigningKey).update(encodedPayload).digest();
  const receivedSignature = Buffer.from(encodedSignature, "base64url");
  if (receivedSignature.toString("base64url") !== encodedSignature ||
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)) throw new Error("Invalid cursor signature");
  const decoded = Buffer.from(encodedPayload, "base64url");
  if (decoded.toString("base64url") !== encodedPayload) throw new Error("Non-canonical cursor encoding");
  const parsed = JSON.parse(decoded.toString("utf8")) as Partial<VideoCursor>;
  if (
    parsed.v !== 2 || parsed.scopeHash !== hashCursorScope(scope, organizationId) ||
    typeof parsed.expiresAt !== "number" || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt < Date.now() ||
    typeof parsed.snapshotId !== "string" || !uuidPattern.test(parsed.snapshotId) ||
    typeof parsed.position !== "number" || !Number.isSafeInteger(parsed.position) || parsed.position < 0
  ) throw new Error("Invalid cursor payload");
  return parsed as VideoCursor;
}

function hashCursorScope(scope: CursorScope, organizationId: string) {
  return createHash("sha256").update(JSON.stringify({ ...scope, organizationId })).digest("base64url");
}

// PRD video.upload maps to the existing Step 4 videos.create permission.
router.post("/videos/upload-init", requirePermission("videos.create"), requireCreateAccess, async (req, res) => {
  const input = InitializeVideoUploadBody.parse(req.body);
  const requestedFolderId = input.folderId ?? null;
  if (requestedFolderId && !uuidPattern.test(requestedFolderId)) {
    res.status(400).json({ error: "folderId must be a folder UUID or null." });
    return;
  }
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
    if (requestedFolderId) {
      const [folder] = await tx.select({ id: foldersTable.id }).from(foldersTable).where(and(
        eq(foldersTable.organizationId, req.tenant.organizationId),
        eq(foldersTable.id, requestedFolderId),
      )).limit(1);
      if (!folder) throw new UploadFolderNotFoundError();
    }
    const [existing] = await tx.select().from(videosTable).where(and(
      eq(videosTable.organizationId, req.tenant.organizationId),
      eq(videosTable.uploadIdempotencyKey, idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.title !== input.title || existing.uploadSourceBytes !== input.contentLength
        || existing.uploadSourceFileName !== input.fileName || existing.uploadSourceContentType !== input.contentType
        || existing.folderId !== requestedFolderId) {
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
    if (count >= videoLimit) throw new UploadLimitError("video_limit_reached", videoLimit, count);
    if (!organization || organization.storageUsedBytes + input.contentLength > storageLimit) {
      throw new UploadLimitError("storage_limit_reached", storageLimit, organization?.storageUsedBytes ?? 0);
    }

    const [video] = await tx.insert(videosTable).values({
      organizationId: req.tenant.organizationId, title: input.title, description: input.description ?? "",
      folderId: requestedFolderId,
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
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: "upload.requested", category: "content",
      subject: { type: "video", id: video.id, label: video.title },
      afterState: { status: "created", folderId: requestedFolderId }, requestId: String(req.id),
    });
    return { video, newlyReserved: true };
  }).catch((error: unknown) => {
    if (error instanceof UploadLimitError) return {
      error: error.message, code: error.code, limit: error.limit, current: error.current,
    };
    if (error instanceof UploadInputError) return { error: error.message };
    if (error instanceof UploadReplayBlockedError) return { blocked: error.message };
    if (error instanceof UploadFolderNotFoundError) return { missingFolder: true };
    throw error;
  });
  if ("error" in reservation) {
    res.status(403).json({
      error: reservation.error,
      ...("code" in reservation ? { code: reservation.code, limit: reservation.limit, current: reservation.current } : {}),
    });
    return;
  }
  if ("blocked" in reservation) {
    res.status(409).json({ error: reservation.blocked });
    return;
  }
  if ("missingFolder" in reservation) {
    res.status(404).json({ error: "Folder not found" });
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
    if (beforeAssetCreationClaimForTest) {
      await beforeAssetCreationClaimForTest(reservation.video.id, idempotencyKey);
    }
    const [claimed] = await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      assetCreationClaim: claim, assetCreationClaimedAt: new Date(),
    }).where(and(
      scopedVideoWhere(req.tenant.organizationId, reservation.video.id),
      eq(videosTable.uploadIdempotencyKey, idempotencyKey),
      sql`${videosTable.providerAssetId} is null`,
      sql`${videosTable.assetCreationClaim} is null`,
      sql`${videosTable.deletionClaim} is null`,
      sql`${videosTable.reconciliationRequired} is null`,
      or(
        eq(videosTable.status, "created"),
        and(eq(videosTable.status, "error"), eq(videosTable.initializationRetryable, true)),
      ),
    )).returning({ id: videosTable.id }));
    if (!claimed) {
      res.status(409).json({ error: "Upload initialization is in progress; retry with the same idempotency key." });
      return;
    }
  }
  try {
    // The deterministic adapter is only selected in NODE_ENV=test. Production
    // always constructs the configured account-backed Bunny adapter.
    const provider = await resolveProvisioningProvider(spaceData.account, spaceData.space);
    if (!providerAssetId) {
      assetCreationAttempted = true;
      const asset = await provider.createAsset({ id: spaceData.space.providerSpaceId }, { title: input.title });
      providerAssetId = asset.id;
      const [linked] = await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
        providerAccountId: spaceData.account.id, providerTenantSpaceId: spaceData.space.providerSpaceId!,
        providerAssetId: asset.id, assetCreationClaim: null, assetCreationClaimedAt: null,
      }).where(and(
        scopedVideoWhere(req.tenant.organizationId, reservation.video.id),
        eq(videosTable.assetCreationClaim, claim!),
        sql`${videosTable.deletionClaim} is null`,
        sql`${videosTable.reconciliationRequired} is null`,
        or(
          eq(videosTable.status, "created"),
          and(eq(videosTable.status, "error"), eq(videosTable.initializationRetryable, true)),
        ),
      ))
        .returning({ id: videosTable.id }));
      if (!linked) throw new Error("Provider asset was created but its local linkage could not be confirmed");
      assetPersisted = true;
    }
    const credentials = await provider.getUploadCredentials(
      { id: spaceData.space.providerSpaceId }, { id: providerAssetId },
      { fileName: input.fileName, contentType: input.contentType, contentLength: input.contentLength },
    );
    const activated = await withTenantDb(req.tenant, async (tx) => {
      const [changed] = await tx.update(videosTable).set({
        status: "uploading", uploadFailureDetail: null, initializationRetryable: false,
      }).where(and(
        scopedVideoWhere(req.tenant.organizationId, reservation.video.id),
        eq(videosTable.uploadIdempotencyKey, idempotencyKey),
        eq(videosTable.providerAssetId, providerAssetId!),
        sql`${videosTable.deletionClaim} is null`,
        sql`${videosTable.reconciliationRequired} is null`,
        or(
          eq(videosTable.status, "created"),
          eq(videosTable.status, "uploading"),
          and(eq(videosTable.status, "error"), eq(videosTable.initializationRetryable, true)),
        ),
      )).returning({ id: videosTable.id });
      if (!changed) return false;
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: "upload.initialized", category: "content",
        subject: { type: "video", id: reservation.video.id, label: reservation.video.title },
        beforeState: { status: reservation.video.status }, afterState: { status: "uploading" }, requestId: String(req.id),
      });
      return true;
    });
    if (!activated) throw new UploadInitializationOwnershipLostError();
    // Do not expose the stored provider linkage; only transient upload headers
    // and the owned video UUID leave this endpoint.
    res.status(reservation.newlyReserved ? 201 : 200).json(InitializeVideoUploadResponse.parse({
      videoId: reservation.video.id, upload: credentials,
    }));
  } catch (error) {
    if (error instanceof UploadInitializationOwnershipLostError) {
      res.status(409).json({ error: "This upload initialization no longer owns the active upload session." });
      return;
    }
    if (error instanceof AssetCreationRejectedError && assetCreationAttempted) {
      await withTenantDb(req.tenant, async (tx) => {
        await releaseReservationInTransaction(tx, req.tenant.organizationId, reservation.video.id);
        await tx.delete(videosTable).where(scopedVideoWhere(req.tenant.organizationId, reservation.video.id));
      });
      res.status(502).json({ error: "Video provider rejected asset creation. Please try again." });
      return;
    }
    if (!assetCreationAttempted || assetPersisted) {
      await withTenantDb(req.tenant, async (tx) => {
        const [changed] = await tx.update(videosTable).set({
          status: "error",
          uploadFailureDetail: assetPersisted
            ? "Upload credentials are temporarily unavailable; retry with the same idempotency key."
            : "Provider setup is temporarily unavailable; retry with the same idempotency key.",
          assetCreationClaim: null, assetCreationClaimedAt: null, initializationRetryable: true,
        }).where(and(
          scopedVideoWhere(req.tenant.organizationId, reservation.video.id),
          sql`${videosTable.status} <> 'error'`,
          sql`${videosTable.deletionClaim} is null`,
          sql`${videosTable.reconciliationRequired} is null`,
        ))
          .returning({ id: videosTable.id });
        if (changed) await writeAuditEvent(tx, {
          organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId), action: "upload.failed", category: "content",
          subject: { type: "video", id: reservation.video.id, label: reservation.video.title },
          afterState: { status: "error" }, metadata: { code: "upload_initialization_failed" }, requestId: String(req.id),
        });
      });
      req.log.error({ err: error, videoId: reservation.video.id }, "Retryable upload initialization failure");
      res.status(503).json({ error: "Upload initialization is temporarily unavailable. Retry with the same idempotency key." });
      return;
    }
    await withTenantDb(req.tenant, async (tx) => {
      const [changed] = await tx.update(videosTable).set({
        status: "error", uploadFailureDetail: "Provider outcome is unknown and requires reconciliation.",
        reconciliationRequired: "provider asset creation outcome unknown", initializationRetryable: false,
      }).where(and(scopedVideoWhere(req.tenant.organizationId, reservation.video.id), sql`${videosTable.reconciliationRequired} is null`))
        .returning({ id: videosTable.id });
      if (changed) await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId), action: "upload.reconciliation_required", category: "content",
        subject: { type: "video", id: reservation.video.id, label: reservation.video.title },
        afterState: { status: "error", reconciliationRequired: true },
        metadata: { code: "provider_asset_creation_outcome_unknown" }, requestId: String(req.id),
      });
    });
    req.log.error({ err: error, videoId: reservation.video.id }, "Upload initialization outcome is ambiguous");
    res.status(503).json({ error: "Upload initialization could not be confirmed. Retry with the same idempotency key." });
  }
});

router.post("/videos/:videoId/upload-complete", requirePermission("videos.create"), async (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const input = CompleteVideoUploadBody.parse(req.body);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [current] = await tx.select({
      id: videosTable.id,
      title: videosTable.title,
      status: videosTable.status,
      reconciliationRequired: videosTable.reconciliationRequired,
      deletionClaim: videosTable.deletionClaim,
    }).from(videosTable).where(and(
      scopedVideoWhere(req.tenant.organizationId, videoId),
      eq(videosTable.uploadIdempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (!current || current.reconciliationRequired || current.deletionClaim) return undefined;
    if (current.status === "processing" || current.status === "ready") {
      return readVideo(tx, req.tenant.organizationId, videoId);
    }
    if (current.status !== "uploading") return undefined;
    const [updated] = await tx.update(videosTable).set({
      status: "processing", reservationExpiresAt: null, reservedBytes: 0, quotaReleasedAt: new Date(),
      initializationRetryable: false,
    })
      .where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.uploadIdempotencyKey, input.idempotencyKey),
        eq(videosTable.status, current.status),
        sql`${videosTable.reconciliationRequired} is null`,
        sql`${videosTable.deletionClaim} is null`,
      ))
      .returning({ id: videosTable.id, title: videosTable.title });
    if (updated) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: "upload.completed", category: "content",
      subject: { type: "video", id: updated.id, label: updated.title },
      beforeState: { status: "uploading" }, afterState: { status: "processing" }, requestId: String(req.id),
    });
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
  const input = CancelVideoUploadBody.parse(req.body);
  const cancellation = await withTenantDb(req.tenant, async (tx) => {
    const [video] = await tx.select().from(videosTable)
      .where(scopedVideoWhere(req.tenant.organizationId, videoId)).for("update").limit(1);
    if (!video) return { kind: "missing" as const };
    if (video.uploadIdempotencyKey !== input.idempotencyKey) return { kind: "invalid" as const };
    if (
      video.status === "error"
      && video.uploadFailureDetail === "Upload cancelled"
      && !video.reconciliationRequired
      && !video.deletionClaim
    ) {
      return {
        kind: "already_cancelled" as const,
        video: await readVideo(tx, req.tenant.organizationId, videoId),
      };
    }
    if (video.reconciliationRequired) return { kind: "reconciliation" as const };
    if (video.assetCreationClaim) {
      const claimIsFresh = video.assetCreationClaimedAt
        && video.assetCreationClaimedAt.getTime() >= Date.now() - 15 * 60_000;
      if (claimIsFresh) return { kind: "initializing" as const };
      await tx.update(videosTable).set({
        status: "error",
        reconciliationRequired: "provider asset creation outcome unknown",
        uploadFailureDetail: "Upload initialization requires provider reconciliation.",
        initializationRetryable: false,
      }).where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.assetCreationClaim, video.assetCreationClaim),
      ));
      return { kind: "reconciliation" as const };
    }
    if (video.deletionClaim) {
      const claimIsFresh = video.deletionClaimedAt
        && video.deletionClaimedAt.getTime() >= Date.now() - 15 * 60_000;
      if (claimIsFresh) return { kind: "in_progress" as const };
      await tx.update(videosTable).set({
        status: "error",
        reconciliationRequired: "upload cancellation provider deletion outcome unknown",
        uploadFailureDetail: "Cancellation requires provider reconciliation.",
        initializationRetryable: false,
      }).where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.deletionClaim, video.deletionClaim),
      ));
      return { kind: "reconciliation" as const };
    }
    if (
      video.status !== "created"
      && video.status !== "uploading"
      && !(video.status === "error" && video.initializationRetryable)
    ) {
      return { kind: "invalid" as const };
    }
    const claim = randomUUID();
    const [claimed] = await tx.update(videosTable).set({
      deletionClaim: claim,
      deletionClaimedAt: new Date(),
    }).where(and(
      scopedVideoWhere(req.tenant.organizationId, videoId),
      eq(videosTable.uploadIdempotencyKey, input.idempotencyKey),
      sql`${videosTable.deletionClaim} is null`,
      sql`${videosTable.reconciliationRequired} is null`,
    )).returning({ id: videosTable.id });
    return claimed
      ? { kind: "claimed" as const, video, claim }
      : { kind: "in_progress" as const };
  });
  if (cancellation.kind === "missing") {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  if (cancellation.kind === "already_cancelled") {
    res.json(cancellation.video);
    return;
  }
  if (cancellation.kind === "invalid") {
    res.status(409).json({ error: "This upload cannot be cancelled with this session in its current state." });
    return;
  }
  if (cancellation.kind === "in_progress") {
    res.status(409).json({ error: "Upload cancellation is already in progress." });
    return;
  }
  if (cancellation.kind === "initializing") {
    res.status(409).json({ error: "Upload initialization is still in progress." });
    return;
  }
  if (cancellation.kind === "reconciliation") {
    res.status(409).json({ error: "Upload cancellation requires provider reconciliation." });
    return;
  }
  const { video, claim } = cancellation;
  let providerDeletionAttempted = false;
  try {
    if (video.providerAssetId) {
      if (!video.providerTenantSpaceId || !video.providerAccountId) {
        await markCancellationReconciliation(
          req,
          video,
          claim,
          "incomplete provider linkage prevents safe upload cancellation",
        );
        res.status(409).json({ error: "Upload cancellation requires provider reconciliation." });
        return;
      }
      const providerAccountId = video.providerAccountId;
      const providerTenantSpaceId = video.providerTenantSpaceId;
      const spaceData = await withTenantDb(req.tenant, async (tx) => {
        const [row] = await tx.select({ space: providerTenantSpacesTable, account: providerAccountsTable })
          .from(providerTenantSpacesTable).innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
          .where(and(
            eq(providerTenantSpacesTable.organizationId, req.tenant.organizationId),
            eq(providerTenantSpacesTable.providerAccountId, providerAccountId),
            eq(providerTenantSpacesTable.providerSpaceId, providerTenantSpaceId),
          )).limit(1);
        return row;
      });
      if (!spaceData?.space.providerSpaceId) {
        await releaseDeletionClaim(req, videoId, claim);
        res.status(503).json({ error: "Video provider is unavailable." });
        return;
      }
      let provider;
      try {
        provider = await resolveProvisioningProvider(spaceData.account, spaceData.space);
      } catch (error) {
        await releaseDeletionClaim(req, videoId, claim);
        req.log.error({ err: error, videoId }, "Upload cancellation provider resolution failed");
        res.status(503).json({ error: "Video provider is unavailable." });
        return;
      }
      providerDeletionAttempted = true;
      await provider.deleteAsset({ id: providerTenantSpaceId }, { id: video.providerAssetId });
    }
    const cancelled = await withTenantDb(req.tenant, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
      await releaseReservationInTransaction(tx, req.tenant.organizationId, videoId);
      const [changed] = await tx.update(videosTable).set({
        status: "error", uploadFailureDetail: "Upload cancelled", initializationRetryable: false,
        deletionClaim: null, deletionClaimedAt: null,
      }).where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.deletionClaim, claim),
        sql`${videosTable.reconciliationRequired} is null`,
      )).returning({ id: videosTable.id });
      if (!changed) throw new Error("Upload cancellation claim changed before completion");
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: "upload.cancelled", category: "content",
        subject: { type: "video", id: videoId, label: video.title },
        beforeState: { status: video.status }, afterState: { status: "error" }, requestId: String(req.id),
      });
      return readVideo(tx, req.tenant.organizationId, videoId);
    });
    res.json(cancelled);
  } catch (error) {
    if (!providerDeletionAttempted) {
      await releaseDeletionClaim(req, videoId, claim).catch(() => undefined);
      req.log.error({ err: error, videoId }, "Upload cancellation local completion failed");
      res.status(503).json({ error: "Cancellation is temporarily unavailable. Please retry." });
      return;
    }
    await markCancellationReconciliation(
      req,
      video,
      claim,
      "upload cancellation provider deletion outcome unknown",
    );
    req.log.error({ err: error, videoId }, "Upload cancellation outcome is ambiguous");
    res.status(503).json({ error: "Cancellation could not be confirmed and requires reconciliation." });
  }
});

class UploadInputError extends Error {}
class UploadLimitError extends UploadInputError {
  constructor(readonly code: string, readonly limit: number, readonly current: number) {
    super(code === "video_limit_reached" ? "Video limit reached for this workspace." : "Storage limit reached for this workspace.");
  }
}
class UploadReplayBlockedError extends Error {}
class UploadFolderNotFoundError extends Error {}
class UploadInitializationOwnershipLostError extends Error {}

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

async function releaseDeletionClaim(req: Request, videoId: string, claim: string) {
  await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
    deletionClaim: null,
    deletionClaimedAt: null,
  }).where(and(
    scopedVideoWhere(req.tenant.organizationId, videoId),
    eq(videosTable.deletionClaim, claim),
  )));
}

async function markCancellationReconciliation(
  req: Request,
  video: typeof videosTable.$inferSelect,
  claim: string,
  reason: string,
) {
  await withTenantDb(req.tenant, async (tx) => {
    const [changed] = await tx.update(videosTable).set({
      status: "error",
      reconciliationRequired: reason,
      uploadFailureDetail: "Cancellation requires provider reconciliation.",
      initializationRetryable: false,
    }).where(and(
      scopedVideoWhere(req.tenant.organizationId, video.id),
      eq(videosTable.deletionClaim, claim),
    )).returning({ id: videosTable.id });
    if (changed) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId,
      actor: auditUser(req.tenant.userId),
      action: "upload.cancelled_ambiguous",
      category: "content",
      subject: { type: "video", id: video.id, label: video.title },
      beforeState: { status: video.status },
      afterState: { status: "error", reconciliationRequired: true },
      requestId: String(req.id),
    });
  });
}

router.get("/videos/:videoId", requirePermission("videos.read"), async (req, res) => {
  const { videoId } = GetVideoParams.parse(req.params);
  const video = await withTenantDb(req.tenant, (tx) => readVideo(tx, req.tenant.organizationId, videoId));
  if (!video) return void res.status(404).json({ error: "Video not found" });
  const [embed] = await withTenantDb(req.tenant, (tx) => tx.select().from(videoEmbedsTable)
    .where(eq(videoEmbedsTable.videoId, videoId)).limit(1));
  res.json(GetVideoResponse.parse({
    ...video,
    ...(embed?.generationStatus === "generated"
      ? serializeEmbed(embed, trustedRequestOrigin(req), {
        title: video.title, description: video.description, durationSeconds: video.durationSeconds,
      })
      : {}),
  }));
});

router.get("/videos/:videoId/playback", requirePermission("videos.read"), async (req, res): Promise<void> => {
  const { videoId } = GetVideoParams.parse(req.params);
  setPlaybackResponsePolicy(res);
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select({
      id: videosTable.id, title: videosTable.title, description: videosTable.description,
      status: videosTable.status, visibility: videosTable.visibility,
      durationSeconds: videosTable.durationSeconds, thumbnailColor: videosTable.thumbnailColor,
      thumbnailObjectKey: videosTable.thumbnailObjectKey,
      thumbnailVersion: videosTable.thumbnailVersion,
      thumbnailMutableUntil: videosTable.thumbnailMutableUntil,
      playerAccent: organizationCustomizationTable.playerAccent,
      playerControlForeground: organizationCustomizationTable.playerControlForeground,
      playerControlBackground: organizationCustomizationTable.playerControlBackground,
      posterTreatment: organizationCustomizationTable.posterTreatment,
      providerAssetId: videosTable.providerAssetId, providerTenantSpaceId: videosTable.providerTenantSpaceId,
      account: providerAccountsTable, space: providerTenantSpacesTable,
    }).from(videosTable)
      .innerJoin(organizationCustomizationTable, eq(organizationCustomizationTable.organizationId, videosTable.organizationId))
      .leftJoin(providerAccountsTable, eq(providerAccountsTable.id, videosTable.providerAccountId))
      .leftJoin(providerTenantSpacesTable, and(
        eq(providerTenantSpacesTable.organizationId, videosTable.organizationId),
        eq(providerTenantSpacesTable.providerAccountId, videosTable.providerAccountId),
        eq(providerTenantSpacesTable.providerSpaceId, videosTable.providerTenantSpaceId),
      ))
      .where(scopedVideoWhere(req.tenant.organizationId, videoId)).limit(1);
    return row;
  });
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  const {
    providerAssetId, providerTenantSpaceId, account, space, thumbnailObjectKey, thumbnailVersion,
    thumbnailMutableUntil, ...baseMetadata
  } = video;
  const thumbnailUrl = thumbnailObjectKey && thumbnailVersion
    && (!thumbnailMutableUntil || thumbnailMutableUntil.getTime() <= Date.now())
    ? `/api/videos/${videoId}/thumbnail?v=${thumbnailVersion}` : null;
  const metadata = { ...baseMetadata, thumbnailUrl, posterUrl: thumbnailUrl };
  if (video.status !== "ready") {
    res.json(GetAuthenticatedVideoPlaybackResponse.parse(metadata));
    return;
  }
  if (!providerAssetId || !providerTenantSpaceId || !account || !space) {
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
    const stillEligible = await withTenantDb(req.tenant, async (tx) => {
      const [row] = await tx.select({ id: videosTable.id }).from(videosTable).where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.status, "ready"),
        eq(videosTable.providerAccountId, account.id),
        eq(videosTable.providerTenantSpaceId, providerTenantSpaceId),
        eq(videosTable.providerAssetId, providerAssetId),
      )).limit(1);
      return row;
    });
    if (!stillEligible) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    res.json(GetAuthenticatedVideoPlaybackResponse.parse({
      ...metadata, sourceUrl: `/api/videos/${videoId}/playback/source`, sourceType: "hls",
      sourceExpiresAt: source.expiresAt.toISOString(),
      posterUrl: thumbnailUrl,
    }));
  } catch (error) {
    req.log.error({ err: error, videoId }, "Authenticated playback source resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.get("/videos/:videoId/playback/source", requirePermission("videos.read"), async (req, res): Promise<void> => {
  const { videoId } = GetVideoParams.parse(req.params);
  setPlaybackResponsePolicy(res);
  const linkage = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select({
      providerAssetId: videosTable.providerAssetId, providerTenantSpaceId: videosTable.providerTenantSpaceId,
      account: providerAccountsTable, space: providerTenantSpacesTable,
    }).from(videosTable)
      .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, videosTable.providerAccountId))
      .innerJoin(providerTenantSpacesTable, and(
        eq(providerTenantSpacesTable.organizationId, videosTable.organizationId),
        eq(providerTenantSpacesTable.providerAccountId, videosTable.providerAccountId),
        eq(providerTenantSpacesTable.providerSpaceId, videosTable.providerTenantSpaceId),
      ))
      .where(and(scopedVideoWhere(req.tenant.organizationId, videoId), eq(videosTable.status, "ready"))).limit(1);
    return row;
  });
  if (!linkage?.providerAssetId || !linkage.providerTenantSpaceId) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  const providerAssetId = linkage.providerAssetId;
  const providerTenantSpaceId = linkage.providerTenantSpaceId;
  try {
    const provider = await resolveProvisioningProvider(linkage.account, linkage.space);
    const sources = await provider.getPlaybackSources({ id: providerTenantSpaceId }, { id: providerAssetId });
    const source = await validatePlaybackSource(
      provider,
      { id: providerTenantSpaceId },
      { id: providerAssetId },
      sources,
    );
    const stillEligible = await withTenantDb(req.tenant, async (tx) => {
      const [row] = await tx.select({ id: videosTable.id }).from(videosTable).where(and(
        scopedVideoWhere(req.tenant.organizationId, videoId),
        eq(videosTable.status, "ready"),
        eq(videosTable.providerAccountId, linkage.account.id),
        eq(videosTable.providerTenantSpaceId, providerTenantSpaceId),
        eq(videosTable.providerAssetId, providerAssetId),
      )).limit(1);
      return row;
    });
    if (!stillEligible) {
      res.status(404).json({ error: "Video not found" });
      return;
    }
    res.status(307).setHeader("Location", source.sourceUrl).end();
  } catch (error) {
    req.log.error({ err: error, videoId }, "Authenticated playback redirect resolution failed");
    res.status(503).json({ error: "Playback source is unavailable" });
  }
});

router.patch("/videos/bulk", requirePermission("videos.update"), bulkUpdateVideos);

router.patch("/videos/:videoId", requirePermission("videos.update"), async (req, res) => {
  const { videoId } = UpdateVideoParams.parse(req.params);
  const update = UpdateVideoBody.parse(req.body);
  if (update.folderId && !uuidPattern.test(update.folderId)) {
    res.status(400).json({ error: "folderId must be a folder UUID or null." });
    return;
  }
  const result = await withTenantDb(req.tenant, async (tx) => {
    if (update.folderId !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
    }
    const [current] = await tx.select({
      id: videosTable.id, title: videosTable.title, description: videosTable.description,
      folderId: videosTable.folderId, visibility: videosTable.visibility,
    }).from(videosTable).where(scopedVideoWhere(req.tenant.organizationId, videoId)).limit(1);
    if (!current) return { missing: "video" as const };
    if (update.folderId) {
      const [folder] = await tx.select({ id: foldersTable.id }).from(foldersTable).where(and(
        eq(foldersTable.organizationId, req.tenant.organizationId),
        eq(foldersTable.id, update.folderId),
      )).limit(1);
      if (!folder) return { missing: "folder" as const };
    }
    const changed = Object.entries(update).some(([key, value]) =>
      current[key as keyof typeof current] !== value);
    if (!changed) return { video: await readVideo(tx, req.tenant.organizationId, videoId) };
    const [updated] = await tx.update(videosTable).set(update)
      .where(scopedVideoWhere(req.tenant.organizationId, videoId))
      .returning({ id: videosTable.id });
    if (!updated) return { missing: "video" as const };
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: update.folderId !== undefined ? "video.folder_changed" : "video.updated",
      category: "content", subject: { type: "video", id: videoId, label: update.title ?? current.title },
      ...auditDiff(current, { ...current, ...update }), requestId: String(req.id),
    });
    return { video: await readVideo(tx, req.tenant.organizationId, videoId) };
  });
  if ("missing" in result) {
    res.status(404).json({ error: result.missing === "folder" ? "Folder not found" : "Video not found" });
    return;
  }
  res.json(UpdateVideoResponse.parse(result.video));
});

type VideoActionFailure = {
  videoId: string;
  status: 404 | 409 | 503;
  error: string;
};

async function bulkUpdateVideos(req: Request, res: import("express").Response): Promise<void> {
  const parsed = BulkUpdateVideosBody.safeParse(req.body);
  const raw = isPlainObject(req.body) ? req.body : undefined;
  const operationKeys = raw
    ? ["folderId", "visibility"].filter((key) => Object.prototype.hasOwnProperty.call(raw, key))
    : [];
  const allowedKeys = raw
    ? Object.keys(raw).every((key) => ["operation", "videoIds", "folderId", "visibility"].includes(key))
    : false;
  if (!parsed.success || !raw || !allowedKeys || operationKeys.length !== 1
    || (parsed.success && parsed.data.operation !== operationKeys[0].replace("folderId", "move"))
    || new Set(parsed.data.videoIds).size !== parsed.data.videoIds.length) {
    res.status(400).json({ error: "Invalid bulk video update." });
    return;
  }
  const input = parsed.data;
  const folderOperation = input.operation === "move";
  const folderId = folderOperation ? input.folderId : undefined;
  const visibility = folderOperation ? undefined : input.visibility;
  const result = await withTenantDb(req.tenant, async (tx) => {
    if (folderOperation) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.tenant.organizationId}))`);
      if (folderId) {
        const [folder] = await tx.select({ id: foldersTable.id }).from(foldersTable).where(and(
          eq(foldersTable.organizationId, req.tenant.organizationId),
          eq(foldersTable.id, folderId),
        )).limit(1);
        if (!folder) {
          return {
            succeeded: [],
            failed: input.videoIds.map((videoId): VideoActionFailure => ({
              videoId, status: 404, error: "Folder not found",
            })),
          };
        }
      }
    }
    const succeeded: string[] = [];
    const failed: VideoActionFailure[] = [];
    for (const videoId of input.videoIds) {
      const [current] = await tx.select({
        id: videosTable.id, title: videosTable.title, folderId: videosTable.folderId, visibility: videosTable.visibility,
      })
        .from(videosTable).where(scopedVideoWhere(req.tenant.organizationId, videoId)).limit(1);
      if (!current) {
        failed.push({ videoId, status: 404, error: "Video not found" });
        continue;
      }
      const before = folderOperation ? { folderId: current.folderId } : { visibility: current.visibility };
      const after = folderOperation ? { folderId } : { visibility };
      if (before.folderId === after.folderId && before.visibility === after.visibility) {
        succeeded.push(videoId);
        continue;
      }
      const [updated] = await tx.update(videosTable).set(
        folderOperation ? { folderId } : { visibility: visibility! },
      ).where(scopedVideoWhere(req.tenant.organizationId, videoId)).returning({ id: videosTable.id });
      if (!updated) {
        failed.push({ videoId, status: 404, error: "Video not found" });
        continue;
      }
      await writeAuditEvent(tx, {
        organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
        action: folderOperation ? "video.folder_changed" : "video.visibility_changed",
        category: "content", subject: { type: "video", id: videoId, label: current.title },
        ...auditDiff(before, after), requestId: String(req.id),
      });
      succeeded.push(videoId);
    }
    return { succeeded, failed };
  });
  res.json(BulkUpdateVideosResponse.parse(result));
}

router.post("/videos/bulk-delete", requirePermission("videos.delete"), async (req, res): Promise<void> => {
  const parsed = BulkDeleteVideosBody.safeParse(req.body);
  const raw = isPlainObject(req.body) ? req.body : undefined;
  if (!parsed.success || !raw || Object.keys(raw).some((key) => key !== "videoIds")
    || new Set(parsed.data.videoIds).size !== parsed.data.videoIds.length) {
    res.status(400).json({ error: "Invalid bulk video deletion." });
    return;
  }
  const succeeded: string[] = [];
  const failed: VideoActionFailure[] = [];
  // Provider deletion is intentionally sequential. Each non-idempotent provider
  // call completes (or is quarantined) before the next durable claim is acquired.
  for (const videoId of parsed.data.videoIds) {
    const outcome = await deleteVideoDurably(req, videoId);
    if (outcome.status === 204) succeeded.push(videoId);
    else failed.push({
      videoId,
      status: outcome.status,
      error: outcome.status === 503 ? "Video deletion could not be completed." : outcome.error,
    });
  }
  res.json(BulkDeleteVideosResponse.parse({ succeeded, failed }));
});

router.delete("/videos/:videoId", requirePermission("videos.delete"), async (req, res): Promise<void> => {
  const { videoId } = GetVideoParams.parse(req.params);
  const outcome = await deleteVideoDurably(req, videoId);
  if (outcome.status === 204) {
    res.sendStatus(204);
    return;
  }
  res.status(outcome.status).json({ error: outcome.error });
});

async function deleteVideoDurably(
  req: Request,
  videoId: string,
): Promise<{ status: 204 } | { status: 404 | 409 | 503; error: string }> {
  const organizationId = req.tenant.organizationId;
  const video = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select().from(videosTable)
      .where(scopedVideoWhere(organizationId, videoId)).limit(1);
    return row;
  });
  if (!video) {
    return { status: 404, error: "Video not found" };
  }
  if (video.reconciliationRequired || video.deletionClaim) {
    if (!video.reconciliationRequired && video.deletionClaim) {
      const claimIsFresh = video.deletionClaimedAt
        && video.deletionClaimedAt.getTime() >= Date.now() - 15 * 60_000;
      if (claimIsFresh) {
        return { status: 409, error: "Video deletion is already in progress." };
      }
      await withTenantDb(req.tenant, async (tx) => {
        const [changed] = await tx.update(videosTable).set({
          status: "error",
          reconciliationRequired: "provider asset deletion outcome unknown",
          uploadFailureDetail: "Deletion requires provider reconciliation.",
          initializationRetryable: false,
        }).where(and(
          scopedVideoWhere(organizationId, videoId),
          eq(videosTable.deletionClaim, video.deletionClaim!),
          isNull(videosTable.reconciliationRequired),
        )).returning({ id: videosTable.id });
        if (changed) await writeAuditEvent(tx, {
          organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_reconciliation_required", category: "content",
          subject: { type: "video", id: videoId, label: video.title },
          beforeState: { status: video.status }, afterState: { status: "error", reconciliationRequired: true },
          metadata: { code: "stale_deletion_claim" }, requestId: String(req.id),
        });
      });
    }
    return { status: 409, error: "Video deletion requires provider reconciliation." };
  }

  if (!video.providerAssetId) {
    const claim = await claimVideoForDeletion(req, organizationId, videoId);
    if (!claim) return { status: 409, error: "Video deletion is already in progress or requires reconciliation." };
    await withTenantDb(req.tenant, (tx) => deleteOwnedVideoMetadata(tx, organizationId, videoId, claim, req));
    return { status: 204 };
  }
  if (!video.providerAccountId || !video.providerTenantSpaceId) {
    await withTenantDb(req.tenant, async (tx) => {
      const [changed] = await tx.update(videosTable).set({
        status: "error",
        reconciliationRequired: "incomplete provider linkage prevents safe deletion",
        uploadFailureDetail: "Deletion requires provider reconciliation.",
        initializationRetryable: false,
      }).where(and(scopedVideoWhere(organizationId, videoId), isNull(videosTable.reconciliationRequired)))
        .returning({ id: videosTable.id });
      if (changed) await writeAuditEvent(tx, {
        organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_reconciliation_required", category: "content",
        subject: { type: "video", id: videoId, label: video.title },
        beforeState: { status: video.status }, afterState: { status: "error", reconciliationRequired: true },
        metadata: { code: "incomplete_provider_linkage" }, requestId: String(req.id),
      });
    });
    return { status: 409, error: "Video deletion requires provider reconciliation." };
  }

  const claim = await claimVideoForDeletion(req, organizationId, videoId);
  if (!claim) {
    return { status: 409, error: "Video deletion is already in progress or requires reconciliation." };
  }

  const linkage = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select({ account: providerAccountsTable, space: providerTenantSpacesTable })
      .from(providerTenantSpacesTable)
      .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
      .where(and(
        eq(providerTenantSpacesTable.organizationId, organizationId),
        eq(providerTenantSpacesTable.providerAccountId, video.providerAccountId!),
        eq(providerTenantSpacesTable.providerSpaceId, video.providerTenantSpaceId!),
      )).limit(1);
    return row;
  });
  if (!linkage) {
    await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      deletionClaim: null, deletionClaimedAt: null,
    }).where(and(scopedVideoWhere(organizationId, videoId), eq(videosTable.deletionClaim, claim))));
    return { status: 503, error: "Video provider is unavailable." };
  }

  let provider;
  try {
    provider = await resolveProvisioningProvider(linkage.account, linkage.space);
  } catch (error) {
    await withTenantDb(req.tenant, (tx) => tx.update(videosTable).set({
      deletionClaim: null, deletionClaimedAt: null,
    }).where(and(scopedVideoWhere(organizationId, videoId), eq(videosTable.deletionClaim, claim))));
    req.log.error({ err: error, videoId }, "Video provider resolution failed before deletion");
    return { status: 503, error: "Video provider is unavailable." };
  }

  try {
    await provider.deleteAsset({ id: video.providerTenantSpaceId }, { id: video.providerAssetId });
  } catch (error) {
    await withTenantDb(req.tenant, async (tx) => {
      await tx.update(videosTable).set({
        status: "error",
        reconciliationRequired: "provider asset deletion outcome unknown",
        uploadFailureDetail: "Deletion requires provider reconciliation.",
        initializationRetryable: false,
      }).where(and(scopedVideoWhere(organizationId, videoId), eq(videosTable.deletionClaim, claim)));
      await writeAuditEvent(tx, {
        organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_ambiguous", category: "content",
        subject: { type: "video", id: videoId, label: video.title },
        beforeState: { status: video.status }, afterState: { status: "error", reconciliationRequired: true },
        requestId: String(req.id),
      });
    });
    req.log.error({ err: error, videoId }, "Video provider deletion outcome is ambiguous");
    return { status: 503, error: "Video deletion could not be confirmed and requires reconciliation." };
  }

  try {
    await withTenantDb(req.tenant, (tx) => deleteOwnedVideoMetadata(tx, organizationId, videoId, claim, req));
    return { status: 204 };
  } catch (error) {
    await withTenantDb(req.tenant, async (tx) => {
      const [changed] = await tx.update(videosTable).set({
        status: "error",
        reconciliationRequired: "provider asset deleted but local metadata deletion was not confirmed",
        uploadFailureDetail: "Deletion requires provider reconciliation.",
        initializationRetryable: false,
      }).where(and(
        scopedVideoWhere(organizationId, videoId),
        eq(videosTable.deletionClaim, claim),
        isNull(videosTable.reconciliationRequired),
      )).returning({ id: videosTable.id });
      if (changed) await writeAuditEvent(tx, {
        organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_reconciliation_required", category: "content",
        subject: { type: "video", id: videoId, label: video.title },
        beforeState: { status: video.status }, afterState: { status: "error", reconciliationRequired: true },
        metadata: { code: "local_delete_unconfirmed_after_provider_delete" }, requestId: String(req.id),
      });
    });
    req.log.error({ err: error, videoId }, "Local metadata deletion failed after provider deletion");
    return { status: 503, error: "Video deletion could not be confirmed and requires reconciliation." };
  }
}

async function claimVideoForDeletion(req: Request, organizationId: string, videoId: string) {
  return withTenantDb(req.tenant, async (tx) => {
    const [locked] = await tx.select({
      deletionClaim: videosTable.deletionClaim,
      reconciliationRequired: videosTable.reconciliationRequired,
      assetCreationClaim: videosTable.assetCreationClaim,
      assetCreationClaimedAt: videosTable.assetCreationClaimedAt,
      title: videosTable.title,
      status: videosTable.status,
    }).from(videosTable).where(scopedVideoWhere(organizationId, videoId)).for("update").limit(1);
    if (!locked || locked.deletionClaim || locked.reconciliationRequired) return undefined;
    if (locked.assetCreationClaim) {
      const claimIsFresh = locked.assetCreationClaimedAt
        && locked.assetCreationClaimedAt.getTime() >= Date.now() - 15 * 60_000;
      if (!claimIsFresh) {
        const [changed] = await tx.update(videosTable).set({
          status: "error",
          reconciliationRequired: "provider asset creation outcome unknown",
          uploadFailureDetail: "Deletion requires provider reconciliation.",
          initializationRetryable: false,
        }).where(and(
          scopedVideoWhere(organizationId, videoId),
          eq(videosTable.assetCreationClaim, locked.assetCreationClaim),
          isNull(videosTable.reconciliationRequired),
        )).returning({ id: videosTable.id });
        if (changed) await writeAuditEvent(tx, {
          organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_reconciliation_required", category: "content",
          subject: { type: "video", id: videoId, label: locked.title },
          beforeState: { status: locked.status }, afterState: { status: "error", reconciliationRequired: true },
          metadata: { code: "stale_asset_creation_claim" }, requestId: String(req.id),
        });
      }
      return undefined;
    }
    const [masterOperation] = await tx.select({ id: masterStorageOperationsTable.id })
      .from(masterStorageOperationsTable)
      .where(and(
        eq(masterStorageOperationsTable.organizationId, organizationId),
        eq(masterStorageOperationsTable.videoId, videoId),
        or(
          inArray(masterStorageOperationsTable.state, ["pending", "dispatching", "queued", "processing"]),
          and(
            eq(masterStorageOperationsTable.state, "failed"),
            eq(masterStorageOperationsTable.retryable, true),
          ),
        ),
      ))
      .limit(1);
    if (masterOperation) return undefined;
    const claim = randomUUID();
    const [claimed] = await tx.update(videosTable).set({
      deletionClaim: claim,
      deletionClaimedAt: new Date(),
    }).where(and(
      scopedVideoWhere(organizationId, videoId),
      sql`${videosTable.deletionClaim} is null`,
      sql`${videosTable.reconciliationRequired} is null`,
    )).returning({ id: videosTable.id });
    if (claimed) await writeAuditEvent(tx, {
      organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_requested", category: "content",
      subject: { type: "video", id: videoId, label: locked.title },
      beforeState: { status: locked.status },
      afterState: { deletionInProgress: true },
      requestId: String(req.id),
    });
    return claimed ? claim : undefined;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function deleteOwnedVideoMetadata(
  tx: TenantTransaction,
  organizationId: string,
  videoId: string,
  deletionClaim: string,
  req: Request,
) {
  // Serialize with every thumbnail mutation and verify the persisted lifecycle
  // claim before enumerating object keys or cascading upload intents.
  const [lockedVideo] = await tx.select({
    deletionClaim: videosTable.deletionClaim,
    title: videosTable.title,
  }).from(videosTable).where(scopedVideoWhere(organizationId, videoId)).for("update").limit(1);
  if (!lockedVideo || !deletionClaim || lockedVideo.deletionClaim !== deletionClaim) {
    throw new Error("Owned video deletion claim changed before metadata deletion");
  }
  // This is intentionally before the local destructive delete, preserving the
  // owned subject ID and label if the provider deletion already succeeded.
  await writeAuditEvent(tx, {
    organizationId, actor: auditUser(req.tenant.userId), action: "video.deletion_succeeded", category: "content",
    subject: { type: "video", id: videoId, label: lockedVideo.title },
    afterState: { status: "deleted" },
    requestId: String(req.id),
  });
  await releaseReservationInTransaction(tx, organizationId, videoId);
  const [thumbnail] = await tx.select({ objectKey: videosTable.thumbnailObjectKey })
    .from(videosTable).where(scopedVideoWhere(organizationId, videoId)).limit(1);
  if (thumbnail?.objectKey) {
    await tx.insert(objectCleanupOutboxTable).values({
      organizationId,
      objectKey: thumbnail.objectKey,
      nextAttemptAt: new Date(Date.now() + 5 * 60_000),
    })
      .onConflictDoNothing({ target: objectCleanupOutboxTable.objectKey });
  }
  const candidateThumbnails = await tx.select({
    objectKey: thumbnailUploadIntentsTable.objectKey,
    expiresAt: thumbnailUploadIntentsTable.expiresAt,
  })
    .from(thumbnailUploadIntentsTable).where(and(
      eq(thumbnailUploadIntentsTable.organizationId, organizationId),
      eq(thumbnailUploadIntentsTable.videoId, videoId),
    ));
  if (candidateThumbnails.length) {
    await tx.insert(objectCleanupOutboxTable).values(candidateThumbnails.map(({ objectKey, expiresAt }) => ({
      organizationId,
      objectKey,
      nextAttemptAt: new Date(Math.max(Date.now() + 5 * 60_000, expiresAt.getTime() + 60_000)),
    })))
      .onConflictDoNothing({ target: objectCleanupOutboxTable.objectKey });
  }
  await tx.delete(embedGenerationOutboxTable).where(eq(embedGenerationOutboxTable.videoId, videoId));
  await tx.delete(webhookEventsTable).where(and(
    eq(webhookEventsTable.organizationId, organizationId),
    eq(webhookEventsTable.ownedVideoId, videoId),
  ));
  const condition = and(scopedVideoWhere(organizationId, videoId), eq(videosTable.deletionClaim, deletionClaim));
  const [deleted] = await tx.delete(videosTable).where(condition).returning({ id: videosTable.id });
  if (!deleted) throw new Error("Owned video deletion claim changed before metadata deletion");
}

router.get("/activity", requirePermission("audit.read"), async (req, res) => {
  const activity = await withTenantDb(req.tenant, (tx) => tx.select({
    id: auditLogsTable.id,
    action: auditLogsTable.action,
    subject: auditLogsTable.subjectLabel,
    actor: usersTable.name,
    createdAt: auditLogsTable.createdAt,
  }).from(auditLogsTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorUserId))
    .where(eq(auditLogsTable.organizationId, req.tenant.organizationId))
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
    .limit(10));
  res.json(ListActivityResponse.parse(activity.map((item) => ({ ...item, actor: item.actor ?? "System" }))));
});

type AuditFilters = { category?: string; action?: string; subjectType?: string; subjectId?: string; actorKind?: string; actorUserId?: string; from?: Date; to?: Date; search?: string };
type AuditCursor = { v: 1; tenant: string; filters: string; snapshotAt: string; snapshotId: string; lastAt: string; lastId: string; expiresAt: number };
function auditBadRequest(res: import("express").Response, message: string) { res.status(400).json({ error: message }); }
function auditQuery(req: Request): { limit: number; cursor?: string; filters: AuditFilters } | undefined {
  const allowed = new Set(["limit", "cursor", "category", "action", "subjectType", "subjectId", "actorKind", "actorUserId", "from", "to", "search"]);
  if (Object.keys(req.query).some((key) => !allowed.has(key))) return undefined;
  const single = (key: string) => { const v = req.query[key]; return typeof v === "string" ? v : v === undefined ? undefined : null; };
  const limitText = single("limit"); const limit = limitText === undefined ? 50 : /^\d+$/.test(limitText ?? "") ? Number(limitText) : NaN;
  const category = single("category"), action = single("action"), subjectType = single("subjectType"), subjectId = single("subjectId"), actorKind = single("actorKind"), actorUserId = single("actorUserId"), search = single("search"), cursor = single("cursor");
  const date = (value: string | undefined | null) => value === undefined ? undefined : value && /^\d{4}-\d\d-\d\d(T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;
  const from = date(single("from")), to = date(single("to"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || [action, subjectType].some((v) => v !== undefined && (!v || !auditMachinePattern.test(v)))
    || (category !== undefined && (!category || category.length > 64 || !auditMachinePattern.test(category)))
    || (subjectId !== undefined && (!subjectId || subjectId.length > 200)) || (actorKind !== undefined && (!actorKind || !auditActorKinds.has(actorKind)))
    || (actorUserId !== undefined && (!actorUserId || !uuidPattern.test(actorUserId))) || (search !== undefined && (!search || search.length > 200))
    || from === null || to === null || (from && to && from > to) || cursor === null) return undefined;
  return { limit, cursor: cursor ?? undefined, filters: {
    category: category ?? undefined, action: action ?? undefined, subjectType: subjectType ?? undefined,
    subjectId: subjectId ?? undefined, actorKind: actorKind ?? undefined, actorUserId: actorUserId ?? undefined,
    from: from ?? undefined, to: to ?? undefined, search: search ?? undefined,
  } };
}
function auditFilterHash(filters: AuditFilters) {
  return createHash("sha256").update(JSON.stringify({
    ...filters, from: filters.from?.toISOString(), to: filters.to?.toISOString(),
  })).digest("base64url");
}
function signAuditCursor(payload: AuditCursor) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", cursorSigningKey).update(`audit:v1.${body}`).digest("base64url")}`;
}
function parseAuditCursor(value: string, tenant: string, filters: string): AuditCursor | undefined {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return undefined;
  }
  const expected = createHmac("sha256", cursorSigningKey).update(`audit:v1.${body}`).digest("base64url");
  try {
    const signatureBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    const bodyBytes = Buffer.from(body, "base64url");
    if (signatureBytes.toString("base64url") !== signature
      || bodyBytes.toString("base64url") !== body
      || signatureBytes.length !== expectedBytes.length
      || !timingSafeEqual(signatureBytes, expectedBytes)) return undefined;
    const item = JSON.parse(bodyBytes.toString("utf8")) as AuditCursor;
    return item.v === 1 && item.tenant === tenant && item.filters === filters && item.expiresAt >= Date.now()
      && [item.snapshotAt, item.lastAt].every((d) => !Number.isNaN(Date.parse(d))) && uuidPattern.test(item.snapshotId) && uuidPattern.test(item.lastId) ? item : undefined;
  } catch { return undefined; }
}
function auditWhere(tenant: string, filters: AuditFilters, anchor?: { at: string; id: string }, last?: { at: string; id: string }) {
  const conditions: SQL[] = [eq(auditLogsTable.organizationId, tenant)];
  if (filters.category) conditions.push(eq(auditLogsTable.category, filters.category));
  if (filters.action) conditions.push(eq(auditLogsTable.action, filters.action));
  if (filters.subjectType) conditions.push(eq(auditLogsTable.subjectType, filters.subjectType));
  if (filters.subjectId) conditions.push(eq(auditLogsTable.subjectId, filters.subjectId));
  if (filters.actorKind) conditions.push(eq(auditLogsTable.actorKind, filters.actorKind as "user" | "system" | "webhook" | "job"));
  if (filters.actorUserId) conditions.push(eq(auditLogsTable.actorUserId, filters.actorUserId));
  if (filters.from) conditions.push(gte(auditLogsTable.createdAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogsTable.createdAt, filters.to));
  if (filters.search) conditions.push(or(ilike(auditLogsTable.subjectLabel, `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`), ilike(auditLogsTable.action, `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`))!);
  if (anchor) conditions.push(or(lt(auditLogsTable.createdAt, new Date(anchor.at)), and(eq(auditLogsTable.createdAt, new Date(anchor.at)), lte(auditLogsTable.id, anchor.id)))!);
  if (last) conditions.push(or(lt(auditLogsTable.createdAt, new Date(last.at)), and(eq(auditLogsTable.createdAt, new Date(last.at)), lt(auditLogsTable.id, last.id)))!);
  return and(...conditions);
}
const auditProjection = {
  id: auditLogsTable.id, action: auditLogsTable.action, category: auditLogsTable.category, actorKind: auditLogsTable.actorKind,
  actorUserId: auditLogsTable.actorUserId, actorName: usersTable.name, subjectType: auditLogsTable.subjectType,
  subjectId: auditLogsTable.subjectId, subjectLabel: auditLogsTable.subjectLabel, beforeState: auditLogsTable.beforeState,
  afterState: auditLogsTable.afterState, metadata: auditLogsTable.metadata, requestId: auditLogsTable.requestId, createdAt: auditLogsTable.createdAt,
};
type AuditRow = {
  id: string; action: string; category: string; actorKind: "user" | "system" | "webhook" | "job";
  actorUserId: string | null; actorName: string | null; subjectType: string; subjectId: string | null; subjectLabel: string;
  beforeState: Record<string, unknown> | null; afterState: Record<string, unknown> | null; metadata: Record<string, unknown>; requestId: string | null; createdAt: Date;
};
router.get("/audit-events", requirePermission("audit.read"), async (req, res) => {
  const parsed = auditQuery(req); if (!parsed) return auditBadRequest(res, "Invalid audit query");
  const hash = auditFilterHash(parsed.filters); const cursor = parsed.cursor ? parseAuditCursor(parsed.cursor, req.tenant.organizationId, hash) : undefined;
  if (parsed.cursor && !cursor) return auditBadRequest(res, "Invalid or expired audit cursor");
  const result = await withTenantDb(req.tenant, async (tx) => {
    let anchor = cursor && { at: cursor.snapshotAt, id: cursor.snapshotId };
    if (!anchor) {
      const [latest] = await tx.select({ at: auditLogsTable.createdAt, id: auditLogsTable.id }).from(auditLogsTable)
        .where(auditWhere(req.tenant.organizationId, parsed.filters)).orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id)).limit(1);
      anchor = latest ? { at: latest.at.toISOString(), id: latest.id } : { at: new Date().toISOString(), id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    }
    const items = await tx.select(auditProjection).from(auditLogsTable).leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorUserId))
      .where(auditWhere(req.tenant.organizationId, parsed.filters, anchor, cursor && { at: cursor.lastAt, id: cursor.lastId }))
      .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id)).limit(parsed.limit + 1);
    return { anchor, items };
  }, { isolationLevel: "repeatable read" });
  const page = result.items.slice(0, parsed.limit); const more = result.items.length > parsed.limit; const tail = page.at(-1);
  res.json({ items: page.map((item) => ({
    id: item.id, action: item.action, category: item.category, beforeState: item.beforeState, afterState: item.afterState,
    metadata: item.metadata, requestId: item.requestId, createdAt: item.createdAt,
    actor: { kind: item.actorKind, userId: item.actorUserId, name: item.actorName ?? (item.actorKind === "user" ? "Unknown user" : "System") },
    subject: { type: item.subjectType, id: item.subjectId, label: item.subjectLabel },
  })), snapshotAt: result.anchor.at, nextCursor: more && tail ? signAuditCursor({ v: 1, tenant: req.tenant.organizationId, filters: hash, snapshotAt: result.anchor.at, snapshotId: result.anchor.id, lastAt: tail.createdAt.toISOString(), lastId: tail.id, expiresAt: Date.now() + cursorLifetimeMs }) : null });
});

function csvField(value: unknown) {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : value instanceof Date ? value.toISOString() : JSON.stringify(value);
  // Spreadsheet programs evaluate these prefixes even in a quoted CSV cell.
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const auditExportMaxRows = 10_000;
export const AUDIT_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const auditExportBatchSize = 250;
const auditExportHeader = ["id", "created_at", "category", "action", "actor_kind", "actor_user_id", "actor_name", "subject_type", "subject_id", "subject_label", "before_state", "after_state", "metadata", "request_id"];
function auditCsvLine(row: unknown[]) {
  return `${row.map(csvField).join(",")}\r\n`;
}
router.get("/audit-events/export", requirePermission("audit.export"), async (req, res) => {
  // Reuse the strict filter parser while intentionally ignoring pagination state.
  const query = { ...req.query, limit: "100", cursor: undefined };
  const parsed = auditQuery({ ...req, query } as unknown as Request);
  if (!parsed) return auditBadRequest(res, "Invalid audit export query");
  const now = new Date(); const to = parsed.filters.to ?? now;
  const from = parsed.filters.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (from > to || to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) {
    return auditBadRequest(res, "Audit export range must be ordered and may not exceed 90 days");
  }
  parsed.filters.from = from; parsed.filters.to = to;
  let exported: { body: string; truncated: boolean };
  try {
    await withTenantDb(req.tenant, (tx) =>
      consumeAuditExportLimit(tx, req.tenant.organizationId, req.tenant.userId));
  } catch (error) {
    if (error instanceof AuditExportRateLimitError) {
      res.set("Retry-After", String(error.retryAfter)).status(429).json({ error: error.message }); return;
    }
    throw error;
  }
  try {
    exported = await withTenantDb(req.tenant, async (tx) => {
      const lines = [auditCsvLine(auditExportHeader)];
      let bytes = Buffer.byteLength(lines[0], "utf8");
      let count = 0;
      let last: { at: string; id: string } | undefined;
      let truncated = false;
      while (!truncated && count <= auditExportMaxRows) {
        const batch = await tx.select(auditProjection).from(auditLogsTable)
          .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorUserId))
          .where(auditWhere(req.tenant.organizationId, parsed.filters, undefined, last))
          .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
          .limit(Math.min(auditExportBatchSize, auditExportMaxRows + 1 - count));
        if (batch.length === 0) break;
        for (const row of batch) {
          if (count >= auditExportMaxRows) {
            truncated = true;
            break;
          }
          const line = auditCsvLine([row.id, row.createdAt, row.category, row.action, row.actorKind, row.actorUserId, row.actorName, row.subjectType, row.subjectId, row.subjectLabel, row.beforeState, row.afterState, row.metadata, row.requestId]);
          const lineBytes = Buffer.byteLength(line, "utf8");
          if (bytes + lineBytes > AUDIT_EXPORT_MAX_BYTES) {
            truncated = true;
            break;
          }
          lines.push(line);
          bytes += lineBytes;
          count += 1;
        }
        const tail = batch.at(-1);
        if (truncated || batch.length < auditExportBatchSize || !tail) break;
        last = { at: tail.createdAt.toISOString(), id: tail.id };
      }
      return { body: lines.join(""), truncated };
    }, { isolationLevel: "repeatable read" });
  } catch (error) { throw error; }
  res.status(200).set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"audit-events.csv\"",
    "X-Audit-Export-Truncated": exported.truncated ? "true" : "false",
    "X-Content-Type-Options": "nosniff",
  }).send(exported.body);
});

export default router;