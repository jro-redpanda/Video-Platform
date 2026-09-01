import {
  auditLogsTable,
  db,
  groupPermissionsTable,
  membershipsTable,
  organizationCustomizationTable,
  organizationsTable,
  permissionGroupsTable,
  permissionsTable,
  plansTable,
  usersTable,
  videoAnalyticsRollupsTable,
  videoEmbedsTable,
  videosTable,
} from "@workspace/db";
import { and, eq, or, sql } from "drizzle-orm";
import { runtimeConfig } from "./config";
import { EMBED_GENERATION_VERSION } from "./video-embeds";

export const developmentTenant = {
  organizationId: "a23d95cc-33a5-4ca9-8220-cd2192bf86e8",
  planId: "4cd97a42-a1ee-493e-a7fb-b6e03a5f261f",
  userId: "217fc5f4-5195-4c75-ae80-ac245efb2a6c",
  groupId: "27651198-349c-416a-a7f2-8436d0e1293c",
  editorGroupId: "2f5c55b8-0b7c-4681-8842-71bc0fc21f29",
  viewerGroupId: "432b23d3-e5d8-4d5b-9257-cc12ff04ec1c",
} as const;

const permissionCatalog = [
  ["workspace.manage", "Manage workspace settings and branding"],
  ["videos.read", "View the video library"],
  ["videos.create", "Create videos and upload media"],
  ["videos.update", "Edit video metadata and visibility"],
  ["videos.delete", "Delete videos and provider media"],
  ["members.manage", "Invite, suspend, and assign members"],
  ["analytics.read", "View workspace analytics"],
] as const;

// MOCK: replaced at step 18
export async function bootstrapDevelopmentTenant() {
  // Security initialization is required in every environment; only fixtures
  // below are development-only.
  await ensureTenantIsolation();
  await reconcileSystemVideoDeletePermission();
  if (process.env.NODE_ENV === "production") return;

  await db.transaction(async (tx) => {
    await tx.insert(plansTable).values({
      id: developmentTenant.planId,
      code: "growth",
      name: "Growth",
      storageLimitGb: 500,
      entitlements: {
        "branding.logo": true,
        "branding.player_colors": true,
        "branding.watermark": true,
        "branding.custom_domain": false,
        "limits.max_users": 25,
        "limits.max_storage_gb": 500,
        "limits.max_videos": 500,
        "limits.monthly_bandwidth_gb": 2_000,
        "feature.custom_groups": true,
        "feature.api_access": true,
        "feature.captions": true,
        "feature.analytics_export": true,
      },
    }).onConflictDoUpdate({
      target: plansTable.code,
      set: {
        name: "Growth",
        storageLimitGb: 500,
        entitlements: {
          "branding.logo": true,
          "branding.player_colors": true,
          "branding.watermark": true,
          "branding.custom_domain": false,
          "limits.max_users": 25,
          "limits.max_storage_gb": 500,
          "limits.max_videos": 500,
          "limits.monthly_bandwidth_gb": 2_000,
          "feature.custom_groups": true,
          "feature.api_access": true,
          "feature.captions": true,
          "feature.analytics_export": true,
        },
      },
    });

    await tx.insert(organizationsTable).values({
      id: developmentTenant.organizationId,
      name: runtimeConfig.productName,
      slug: "vid",
      status: "active",
      planId: developmentTenant.planId,
      storageUsedBytes: 307_519_904_154,
    }).onConflictDoNothing();

    await tx.insert(organizationCustomizationTable).values({
      organizationId: developmentTenant.organizationId,
      playerAccent: "#6C5CE7",
      playerControlForeground: "#FFFFFF",
      playerControlBackground: "#111827",
      logoInitials: "V",
    }).onConflictDoNothing();

    await tx.insert(usersTable).values({
      id: developmentTenant.userId,
      email: "owner@vid.local",
      name: "Workspace Owner",
      emailVerifiedAt: new Date(),
    }).onConflictDoNothing();

    await tx.insert(permissionGroupsTable).values({
      id: developmentTenant.groupId,
      organizationId: developmentTenant.organizationId,
      name: "Owners",
      description: "Full workspace access",
    }).onConflictDoNothing();

    await tx.insert(permissionGroupsTable).values([
      {
        id: developmentTenant.editorGroupId,
        organizationId: developmentTenant.organizationId,
        name: "Editors",
        description: "Create and manage videos",
      },
      {
        id: developmentTenant.viewerGroupId,
        organizationId: developmentTenant.organizationId,
        name: "Viewers",
        description: "View videos and analytics",
      },
    ]).onConflictDoNothing();

    await tx.insert(permissionsTable).values(
      permissionCatalog.map(([key, description]) => ({ key, description })),
    ).onConflictDoNothing();

    await tx.insert(groupPermissionsTable).values(
      [
        ...permissionCatalog.map(([permissionKey]) => ({
          groupId: developmentTenant.groupId,
          permissionKey,
        })),
        ...["videos.read", "videos.create", "videos.update", "videos.delete", "analytics.read"].map((permissionKey) => ({
          groupId: developmentTenant.editorGroupId,
          permissionKey,
        })),
        ...["videos.read", "analytics.read"].map((permissionKey) => ({
          groupId: developmentTenant.viewerGroupId,
          permissionKey,
        })),
      ],
    ).onConflictDoNothing();

    await tx.insert(membershipsTable).values({
      organizationId: developmentTenant.organizationId,
      userId: developmentTenant.userId,
      groupId: developmentTenant.groupId,
      status: "active",
    }).onConflictDoNothing();

    // MOCK: replaced at step 9
    const demoVideos = [
      ["e164a502-a6ed-41a4-98d4-f0e6bd77d392", "Launch film — Cut 04", "Final launch edit for the fall product campaign.", "ready", "public", 143, "#7457D9"],
      ["a88ff359-a76b-4e55-8e34-d2f50ab81952", "Customer story: Field Notes", "A customer profile captured in Portland.", "ready", "unlisted", 317, "#D06B45"],
      ["935a88ef-31c8-432c-aa51-f022632a4f45", "Product walkthrough", "Guided tour for onboarding and sales enablement.", "processing", "private", 489, "#2E9C8A"],
      ["e2673705-bf63-45e5-88ee-176044e0ff8c", "Studio session 12", "Behind-the-scenes footage from the campaign studio.", "ready", "private", 688, "#3575A8"],
    ] as const;

    await tx.insert(videosTable).values(demoVideos.map(([id, title, description, status, visibility, durationSeconds, thumbnailColor], index) => ({
      id,
      organizationId: developmentTenant.organizationId,
      title,
      description,
      status,
      visibility,
      durationSeconds,
      thumbnailColor,
      createdAt: new Date(Date.UTC(2026, 7, 22 + index * 2, 12, 0)),
    }))).onConflictDoNothing();

    // Development-only owned embed records let the library exercise generated
    // embed code without inventing provider linkage or playback sources.
    await tx.insert(videoEmbedsTable).values(demoVideos
      .filter(([, , , status]) => status === "ready")
      .map(([id, title, description, , , durationSeconds]) => ({
        videoId: id,
        embedPath: `/v/${id}`,
        generationVersion: EMBED_GENERATION_VERSION,
        generationStatus: "generated",
        generatedMetadata: { title, description, durationSeconds },
        generatedAt: new Date(),
      }))).onConflictDoNothing();

    // MOCK: replaced at step 16
    await tx.insert(videoAnalyticsRollupsTable).values([
      { organizationId: developmentTenant.organizationId, videoId: demoVideos[0][0], day: "2026-09-01", plays: 18420, watchTimeSeconds: 1_540_000, completionRate: 72.8 },
      { organizationId: developmentTenant.organizationId, videoId: demoVideos[1][0], day: "2026-09-01", plays: 9327, watchTimeSeconds: 1_210_000, completionRate: 81.2 },
      { organizationId: developmentTenant.organizationId, videoId: demoVideos[3][0], day: "2026-09-01", plays: 6411, watchTimeSeconds: 1_885_360, completionRate: 64.3 },
    ]).onConflictDoNothing();

    // MOCK: replaced at step 17
    await tx.insert(auditLogsTable).values([
      { id: "7241e25f-70e3-4786-afda-340f62895e85", organizationId: developmentTenant.organizationId, actorUserId: developmentTenant.userId, action: "published", subjectType: "video", subjectId: demoVideos[0][0], subjectLabel: demoVideos[0][1] },
      { id: "045a79f0-e374-4349-8e27-a3627ca18752", organizationId: developmentTenant.organizationId, actorUserId: developmentTenant.userId, action: "updated player styling for", subjectType: "organization", subjectId: developmentTenant.organizationId, subjectLabel: runtimeConfig.productName },
    ]).onConflictDoNothing();
  });

}

/**
 * Backfills only the canonical seeded Owner/Editor groups. Exact name and
 * description matching deliberately avoids changing custom groups.
 */
export async function reconcileSystemVideoDeletePermission() {
  await db.transaction(async (tx) => {
    await tx.insert(permissionsTable).values({
      key: "videos.delete", description: "Delete videos and provider media",
    }).onConflictDoNothing();
    const groups = await tx.select({ id: permissionGroupsTable.id }).from(permissionGroupsTable).where(or(
      and(eq(permissionGroupsTable.name, "Owners"), eq(permissionGroupsTable.description, "Full workspace access")),
      and(eq(permissionGroupsTable.name, "Editors"), eq(permissionGroupsTable.description, "Create and manage videos")),
    ));
    if (groups.length) {
      await tx.insert(groupPermissionsTable).values(
        groups.map(({ id }) => ({ groupId: id, permissionKey: "videos.delete" })),
      ).onConflictDoNothing();
    }
  });
}

const tenantTables = [
  "organization_customization",
  "permission_groups",
  "memberships",
  "invitations",
  "folders",
  "videos",
  "video_analytics_rollups",
  "playback_events",
  "provider_tenant_spaces",
  "organization_entitlement_overrides",
  "audit_logs",
] as const;

async function ensureTenantIsolation() {
  await db.execute(sql.raw(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'vid_app') then
        create role vid_app nologin;
      end if;
    end
    $$;
    grant usage on schema public to vid_app;
    grant select, insert, update, delete on all tables in schema public to vid_app;
    grant usage, select on all sequences in schema public to vid_app;
    alter default privileges in schema public grant select, insert, update, delete on tables to vid_app;
    alter default privileges in schema public grant usage, select on sequences to vid_app;
  `));

  for (const table of tenantTables) {
    const expression = "organization_id = nullif(current_setting('app.organization_id', true), '')::uuid";
    await db.execute(sql.raw(`
      alter table "${table}" enable row level security;
      drop policy if exists tenant_isolation on "${table}";
      create policy tenant_isolation on "${table}"
        for all to vid_app
        using (${expression})
        with check (${expression});
    `));
  }
}