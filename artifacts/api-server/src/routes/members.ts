import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  groupPermissionsTable,
  invitationsTable,
  membershipsTable,
  permissionGroupsTable,
  permissionsTable,
  usersTable,
} from "@workspace/db";
import {
  CreateInvitationBody,
  CreateInvitationResponse,
  CreatePermissionGroupBody,
  CreatePermissionGroupResponse,
  DeletePermissionGroupParams,
  ListMembersResponse,
  ListPermissionsResponse,
  ListPermissionGroupsResponse,
  UpdateMemberBody,
  UpdateMemberParams,
  UpdateMemberResponse,
  UpdatePermissionGroupBody,
  UpdatePermissionGroupParams,
  UpdatePermissionGroupResponse,
} from "@workspace/api-zod";
import { requirePermission } from "../lib/permissions";
import { withTenantDb } from "../lib/tenant-db";

const router: IRouter = Router();

async function readGroup(
  tx: Parameters<Parameters<typeof withTenantDb>[1]>[0],
  organizationId: string,
  groupId: string,
) {
  const [group] = await tx.select({
    id: permissionGroupsTable.id,
    name: permissionGroupsTable.name,
    description: permissionGroupsTable.description,
    permissions: sql<string[]>`coalesce(array_agg(${groupPermissionsTable.permissionKey}) filter (where ${groupPermissionsTable.permissionKey} is not null), '{}')`,
  }).from(permissionGroupsTable)
    .leftJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, permissionGroupsTable.id))
    .where(and(
      eq(permissionGroupsTable.organizationId, organizationId),
      eq(permissionGroupsTable.id, groupId),
    ))
    .groupBy(permissionGroupsTable.id);
  return group;
}

async function countOtherPermissionHolders(
  tx: Parameters<Parameters<typeof withTenantDb>[1]>[0],
  organizationId: string,
  permissionKey: string,
  excludedGroupId?: string,
  excludedMembershipId?: string,
) {
  const conditions = [
    eq(membershipsTable.organizationId, organizationId),
    eq(membershipsTable.status, "active" as const),
    eq(groupPermissionsTable.permissionKey, permissionKey),
  ];
  if (excludedGroupId) conditions.push(ne(membershipsTable.groupId, excludedGroupId));
  if (excludedMembershipId) conditions.push(ne(membershipsTable.id, excludedMembershipId));
  const [result] = await tx.select({ count: sql<number>`count(distinct ${membershipsTable.id})::int` })
    .from(membershipsTable)
    .innerJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, membershipsTable.groupId))
    .where(and(...conditions));
  return result.count;
}

router.get("/permission-groups", requirePermission("members.manage"), async (req, res) => {
  const groups = await withTenantDb(req.tenant, (tx) => tx.select({
    id: permissionGroupsTable.id,
    name: permissionGroupsTable.name,
    description: permissionGroupsTable.description,
    permissions: sql<string[]>`coalesce(array_agg(${groupPermissionsTable.permissionKey}) filter (where ${groupPermissionsTable.permissionKey} is not null), '{}')`,
  }).from(permissionGroupsTable)
    .leftJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, permissionGroupsTable.id))
    .where(eq(permissionGroupsTable.organizationId, req.tenant.organizationId))
    .groupBy(permissionGroupsTable.id)
    .orderBy(permissionGroupsTable.name));
  res.json(ListPermissionGroupsResponse.parse(groups));
});

router.get("/permissions", requirePermission("members.manage"), async (req, res) => {
  const permissions = await withTenantDb(req.tenant, (tx) => tx.select({
    key: permissionsTable.key,
    description: permissionsTable.description,
  }).from(permissionsTable).orderBy(permissionsTable.key));
  res.json(ListPermissionsResponse.parse(permissions));
});

router.post("/permission-groups", requirePermission("members.manage"), async (req, res) => {
  const input = CreatePermissionGroupBody.parse(req.body);
  const group = await withTenantDb(req.tenant, async (tx) => {
    const valid = input.permissions.length
      ? await tx.select({ key: permissionsTable.key }).from(permissionsTable)
        .where(inArray(permissionsTable.key, input.permissions))
      : [];
    if (valid.length !== input.permissions.length) return undefined;
    const [created] = await tx.insert(permissionGroupsTable).values({
      organizationId: req.tenant.organizationId,
      name: input.name,
      description: input.description,
    }).returning({ id: permissionGroupsTable.id });
    if (input.permissions.length) {
      await tx.insert(groupPermissionsTable).values(
        input.permissions.map((permissionKey) => ({ groupId: created.id, permissionKey })),
      );
    }
    return readGroup(tx, req.tenant.organizationId, created.id);
  });
  if (!group) return void res.status(400).json({ error: "Unknown permission" });
  res.status(201).json(CreatePermissionGroupResponse.parse(group));
});

router.patch("/permission-groups/:groupId", requirePermission("members.manage"), async (req, res) => {
  const { groupId } = UpdatePermissionGroupParams.parse(req.params);
  const input = UpdatePermissionGroupBody.parse(req.body);
  const result = await withTenantDb(req.tenant, async (tx) => {
    const current = await readGroup(tx, req.tenant.organizationId, groupId);
    if (!current) return { status: "missing" as const };
    const valid = input.permissions.length
      ? await tx.select({ key: permissionsTable.key }).from(permissionsTable)
        .where(inArray(permissionsTable.key, input.permissions))
      : [];
    if (valid.length !== input.permissions.length) return { status: "invalid" as const };
    if (current.permissions.includes("members.manage") && !input.permissions.includes("members.manage")) {
      const others = await countOtherPermissionHolders(tx, req.tenant.organizationId, "members.manage", groupId);
      if (others === 0) return { status: "lockout" as const };
    }
    await tx.update(permissionGroupsTable).set({
      name: input.name,
      description: input.description,
    }).where(and(
      eq(permissionGroupsTable.id, groupId),
      eq(permissionGroupsTable.organizationId, req.tenant.organizationId),
    ));
    await tx.delete(groupPermissionsTable).where(eq(groupPermissionsTable.groupId, groupId));
    if (input.permissions.length) {
      await tx.insert(groupPermissionsTable).values(
        input.permissions.map((permissionKey) => ({ groupId, permissionKey })),
      );
    }
    return { status: "ok" as const, group: await readGroup(tx, req.tenant.organizationId, groupId) };
  });
  if (result.status === "missing") return void res.status(404).json({ error: "Permission group not found" });
  if (result.status === "invalid") return void res.status(400).json({ error: "Unknown permission" });
  if (result.status === "lockout") return void res.status(409).json({ error: "At least one active member must retain member administration access" });
  res.json(UpdatePermissionGroupResponse.parse(result.group));
});

router.delete("/permission-groups/:groupId", requirePermission("members.manage"), async (req, res) => {
  const { groupId } = DeletePermissionGroupParams.parse(req.params);
  const result = await withTenantDb(req.tenant, async (tx) => {
    const [usage] = await tx.select({ count: sql<number>`count(*)::int` }).from(membershipsTable)
      .where(and(
        eq(membershipsTable.organizationId, req.tenant.organizationId),
        eq(membershipsTable.groupId, groupId),
      ));
    if (usage.count > 0) return "in-use" as const;
    const [deleted] = await tx.delete(permissionGroupsTable).where(and(
      eq(permissionGroupsTable.organizationId, req.tenant.organizationId),
      eq(permissionGroupsTable.id, groupId),
    )).returning({ id: permissionGroupsTable.id });
    return deleted ? "deleted" as const : "missing" as const;
  });
  if (result === "in-use") return void res.status(409).json({ error: "Reassign members before deleting this group" });
  if (result === "missing") return void res.status(404).json({ error: "Permission group not found" });
  res.status(204).send();
});

router.get("/members", requirePermission("members.manage"), async (req, res) => {
  const members = await withTenantDb(req.tenant, async (tx) => {
    const activeMembers = await tx.select({
      id: membershipsTable.id,
      name: usersTable.name,
      email: usersTable.email,
      groupId: permissionGroupsTable.id,
      role: permissionGroupsTable.name,
      status: membershipsTable.status,
    }).from(membershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .innerJoin(permissionGroupsTable, eq(permissionGroupsTable.id, membershipsTable.groupId))
      .where(eq(membershipsTable.organizationId, req.tenant.organizationId))
      .orderBy(usersTable.name);

    const pendingInvitations = await tx.select({
      id: invitationsTable.id,
      email: invitationsTable.email,
      groupId: permissionGroupsTable.id,
      role: permissionGroupsTable.name,
    }).from(invitationsTable)
      .innerJoin(permissionGroupsTable, eq(permissionGroupsTable.id, invitationsTable.groupId))
      .where(and(
        eq(invitationsTable.organizationId, req.tenant.organizationId),
        isNull(invitationsTable.acceptedAt),
      ))
      .orderBy(desc(invitationsTable.createdAt));

    return [
      ...activeMembers,
      ...pendingInvitations.map((invite) => ({
        ...invite,
        name: invite.email.split("@")[0],
        status: "invited" as const,
      })),
    ];
  });
  res.json(ListMembersResponse.parse(members));
});

router.patch("/members/:membershipId", requirePermission("members.manage"), async (req, res) => {
  const { membershipId } = UpdateMemberParams.parse(req.params);
  const update = UpdateMemberBody.parse(req.body);
  const result = await withTenantDb(req.tenant, async (tx) => {
    const [current] = await tx.select({
      id: membershipsTable.id,
      groupId: membershipsTable.groupId,
      status: membershipsTable.status,
    }).from(membershipsTable).where(and(
      eq(membershipsTable.id, membershipId),
      eq(membershipsTable.organizationId, req.tenant.organizationId),
    )).limit(1);
    if (!current) return { status: "missing" as const };

    if (update.groupId) {
      const [group] = await tx.select({ id: permissionGroupsTable.id }).from(permissionGroupsTable)
        .where(and(
          eq(permissionGroupsTable.id, update.groupId),
          eq(permissionGroupsTable.organizationId, req.tenant.organizationId),
        )).limit(1);
      if (!group) return { status: "invalid" as const };
    }

    const [currentlyAdmin] = await tx.select({ key: groupPermissionsTable.permissionKey })
      .from(groupPermissionsTable)
      .where(and(
        eq(groupPermissionsTable.groupId, current.groupId),
        eq(groupPermissionsTable.permissionKey, "members.manage"),
      )).limit(1);
    const nextGroupId = update.groupId ?? current.groupId;
    const [nextAdmin] = await tx.select({ key: groupPermissionsTable.permissionKey })
      .from(groupPermissionsTable)
      .where(and(
        eq(groupPermissionsTable.groupId, nextGroupId),
        eq(groupPermissionsTable.permissionKey, "members.manage"),
      )).limit(1);
    const losesAdmin = Boolean(currentlyAdmin) && (update.status === "suspended" || !nextAdmin);
    if (current.status === "active" && losesAdmin) {
      const others = await countOtherPermissionHolders(
        tx,
        req.tenant.organizationId,
        "members.manage",
        undefined,
        membershipId,
      );
      if (others === 0) return { status: "lockout" as const };
    }

    await tx.update(membershipsTable).set(update).where(eq(membershipsTable.id, membershipId));
    const [member] = await tx.select({
      id: membershipsTable.id,
      name: usersTable.name,
      email: usersTable.email,
      groupId: permissionGroupsTable.id,
      role: permissionGroupsTable.name,
      status: membershipsTable.status,
    }).from(membershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .innerJoin(permissionGroupsTable, eq(permissionGroupsTable.id, membershipsTable.groupId))
      .where(eq(membershipsTable.id, membershipId));
    return { status: "ok" as const, member };
  });
  if (result.status === "missing") return void res.status(404).json({ error: "Member not found" });
  if (result.status === "invalid") return void res.status(400).json({ error: "Invalid permission group" });
  if (result.status === "lockout") return void res.status(409).json({ error: "At least one active member must retain member administration access" });
  res.json(UpdateMemberResponse.parse(result.member));
});

router.post("/invitations", requirePermission("members.manage"), async (req, res) => {
  const input = CreateInvitationBody.parse(req.body);
  const invitation = await withTenantDb(req.tenant, async (tx) => {
    const [group] = await tx.select({ id: permissionGroupsTable.id, name: permissionGroupsTable.name })
      .from(permissionGroupsTable)
      .where(and(
        eq(permissionGroupsTable.id, input.groupId),
        eq(permissionGroupsTable.organizationId, req.tenant.organizationId),
      ))
      .limit(1);
    if (!group) return undefined;

    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [created] = await tx.insert(invitationsTable).values({
      organizationId: req.tenant.organizationId,
      email: input.email.toLowerCase(),
      groupId: group.id,
      tokenHash,
      invitedByUserId: req.tenant.userId,
      expiresAt,
    }).returning({ id: invitationsTable.id, email: invitationsTable.email });

    return {
      ...created,
      groupId: group.id,
      role: group.name,
      status: "invited" as const,
      expiresAt,
    };
  });

  if (!invitation) return void res.status(400).json({ error: "Invalid permission group" });
  res.status(201).json(CreateInvitationResponse.parse(invitation));
});

export default router;