import { randomUUID } from "node:crypto";
import {
  db, groupPermissionsTable, organizationCustomizationTable, organizationsTable,
  permissionGroupsTable, permissionsTable, providerAccountsTable, providerTenantSpacesTable,
} from "@workspace/db";
import { TenantSpaceCreationRejectedError, type VideoProvider } from "@workspace/providers";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { ProvisioningProviderResolver } from "./provider-registry";

const groups = [
  { name: "Owners", description: "Full workspace access", permissions: ["workspace.manage", "videos.read", "videos.create", "videos.update", "members.manage", "analytics.read"] },
  { name: "Editors", description: "Create and manage videos", permissions: ["videos.read", "videos.create", "videos.update", "analytics.read"] },
  { name: "Viewers", description: "View videos and analytics", permissions: ["videos.read", "analytics.read"] },
] as const;

const catalog = [
  ["workspace.manage", "Manage workspace settings and branding"], ["videos.read", "View the video library"],
  ["videos.create", "Create videos and upload media"], ["videos.update", "Edit video metadata and visibility"],
  ["members.manage", "Invite, suspend, and assign members"], ["analytics.read", "View workspace analytics"],
] as const;

export async function provisionTenantOrganization(organizationId: string, resolveProvider: ProvisioningProviderResolver) {
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  if (!organization) throw new Error(`Organization ${organizationId} does not exist`);
  if (organization.status === "active") return { organizationId, status: "active" as const };

  let space = await db.transaction(async (tx) => {
    // Serialize reservations per organization. Capacity is reserved before the
    // external call, so concurrently queued jobs cannot over-allocate an account.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const [existing] = await tx.select().from(providerTenantSpacesTable)
      .where(eq(providerTenantSpacesTable.organizationId, organizationId)).limit(1);
    if (existing) return existing;
    const [account] = await tx.select().from(providerAccountsTable)
      .where(and(eq(providerAccountsTable.acceptingNewTenants, true), lt(providerAccountsTable.zoneCountCached, providerAccountsTable.maxZones)))
      .orderBy(
        sql`${providerAccountsTable.maxZones} - ${providerAccountsTable.zoneCountCached} desc`,
        providerAccountsTable.id,
      )
      .limit(1);
    if (!account) throw new Error("No provider account has remaining tenant capacity");
    const [reserved] = await tx.update(providerAccountsTable)
      .set({ zoneCountCached: sql`${providerAccountsTable.zoneCountCached} + 1` })
      .where(and(
        eq(providerAccountsTable.id, account.id),
        eq(providerAccountsTable.acceptingNewTenants, true),
        lt(providerAccountsTable.zoneCountCached, providerAccountsTable.maxZones),
      )).returning();
    if (!reserved) throw new Error("Provider account capacity changed while reserving tenant space");
    const [inserted] = await tx.insert(providerTenantSpacesTable).values({
      organizationId, providerAccountId: account.id, idempotencyKey: randomUUID(), state: "creating",
    }).returning();
    return inserted;
  });
  if (!space) throw new Error(`Unable to reserve tenant space for organization ${organizationId}`);

  if (space.state === "creating" && !space.providerSpaceId) {
    const claim = randomUUID();
    const [claimed] = await db.update(providerTenantSpacesTable).set({
      externalCallClaim: claim, externalCallClaimedAt: new Date(),
    }).where(and(
      eq(providerTenantSpacesTable.id, space.id),
      isNull(providerTenantSpacesTable.providerSpaceId),
      isNull(providerTenantSpacesTable.externalCallClaim),
    )).returning();
    if (!claimed) {
      // A surviving claim represents an interrupted external call. Repeating
      // it could create a second remote library, so reconciliation is required.
      await db.update(providerTenantSpacesTable).set({ reconciliationRequired: true })
        .where(eq(providerTenantSpacesTable.id, space.id));
      throw new Error(`Provider tenant-space creation requires reconciliation for ${organizationId}`);
    }
    space = claimed;
    const [account] = await db.select().from(providerAccountsTable).where(eq(providerAccountsTable.id, space.providerAccountId)).limit(1);
    if (!account) throw new Error("Reserved provider account no longer exists");
    let provider: VideoProvider;
    try {
      provider = await resolveProvider(account, space);
    } catch (error) {
      await releaseUnclaimedReservation(space);
      throw error;
    }
    // Bunny persists its ID and credentials through its awaited internal
    // onLibraryCreated callback. Other providers can safely persist the ID here.
    let tenantSpace;
    try {
      tenantSpace = await provider.createTenantSpace({ name: organization.name });
    } catch (error) {
      if (error instanceof TenantSpaceCreationRejectedError) await releaseUnclaimedReservation(space);
      throw error;
    }
    const persisted = await db.update(providerTenantSpacesTable).set({ providerSpaceId: tenantSpace.id, externalCallClaim: null, externalCallClaimedAt: null })
      .where(and(eq(providerTenantSpacesTable.id, space.id), eq(providerTenantSpacesTable.state, "creating"), eq(providerTenantSpacesTable.externalCallClaim, claim)))
      .returning();
    if (persisted.length) space = persisted[0];
    else [space] = await db.select().from(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, space.id)).limit(1);
  }
  if (space?.state === "creating" && space.providerSpaceId) {
    const [created] = await db.update(providerTenantSpacesTable).set({ state: "created" })
      .where(and(eq(providerTenantSpacesTable.id, space.id), eq(providerTenantSpacesTable.state, "creating")))
      .returning();
    if (created) space = created;
  }
  if (!space || space.state !== "created" || !space.providerSpaceId) throw new Error("Provider tenant space was not created");

  await db.transaction(async (tx) => {
    await tx.insert(permissionsTable).values(catalog.map(([key, description]) => ({ key, description }))).onConflictDoNothing();
    await tx.insert(organizationCustomizationTable).values({ organizationId }).onConflictDoNothing();
    for (const group of groups) {
      const [created] = await tx.insert(permissionGroupsTable).values({
        organizationId, name: group.name, description: group.description,
      }).onConflictDoNothing().returning();
      const groupId = created?.id ?? (await tx.select({ id: permissionGroupsTable.id }).from(permissionGroupsTable)
        .where(and(eq(permissionGroupsTable.organizationId, organizationId), eq(permissionGroupsTable.name, group.name))).limit(1))[0]?.id;
      if (!groupId) throw new Error(`Unable to seed ${group.name} group`);
      await tx.insert(groupPermissionsTable).values(group.permissions.map((permissionKey) => ({ groupId, permissionKey }))).onConflictDoNothing();
    }
    await tx.update(organizationsTable).set({ status: "active" }).where(eq(organizationsTable.id, organizationId));
  });
  return { organizationId, status: "active" as const, providerSpaceId: space.providerSpaceId };
}

async function releaseUnclaimedReservation(space: typeof providerTenantSpacesTable.$inferSelect) {
  const [current] = await db.select().from(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.id, space.id)).limit(1);
  // Resolver failures happen before a remote call. If an external ID exists,
  // its outcome is ambiguous and the reservation intentionally remains.
  if (current?.providerSpaceId) return;
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(providerTenantSpacesTable).where(and(
      eq(providerTenantSpacesTable.id, space.id),
      isNull(providerTenantSpacesTable.providerSpaceId),
    )).returning({ id: providerTenantSpacesTable.id });
    if (!deleted.length) return;
    await tx.update(providerAccountsTable).set({
      zoneCountCached: sql`greatest(${providerAccountsTable.zoneCountCached} - 1, 0)`,
    }).where(eq(providerAccountsTable.id, space.providerAccountId));
  });
}