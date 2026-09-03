import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { invitationsTable, membershipsTable, organizationsTable, permissionGroupsTable, usersTable } from "@workspace/db";
import { resolveEntitlements } from "./entitlements";
import { runtimeConfig } from "./config";
import type { InvitationDelivery } from "./invitation-delivery";
import { withOrganizationDb, withTenantDb } from "./tenant-db";
import type { TenantContext } from "./tenant-context";
import { auditUser, writeAuditEvent } from "./audit";
import { lookupAcceptableInvitation } from "./invitation-lookup";
import {
  hashInvitationToken,
  isInvitationToken,
  normalizeInvitationEmail,
} from "./invitation-token";

export { hashInvitationToken } from "./invitation-token";
const lock = (tx: Parameters<Parameters<typeof withOrganizationDb>[1]>[0], org: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${org}))`);
const uniqueViolation = (error: unknown): boolean => Boolean(
  error && typeof error === "object" && (
    ("code" in error && (error as { code?: string }).code === "23505")
    || ("cause" in error && uniqueViolation((error as { cause?: unknown }).cause))
  ),
);
export class InvitationConflictError extends Error {}
export class InvitationUnavailableError extends Error {}

export async function issueInvitation(
  tenant: TenantContext,
  input: { email: string; groupId: string },
  delivery?: InvitationDelivery,
  requestId?: string,
) {
  if (!delivery) throw new InvitationUnavailableError();
  const email = normalizeInvitationEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvitationConflictError();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);
  const pending = await withTenantDb(tenant, async (tx) => {
    await lock(tx, tenant.organizationId);
    const now = new Date();
    await tx.update(invitationsTable).set({ revokedAt: now }).where(and(eq(invitationsTable.organizationId, tenant.organizationId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt), sql`lower(${invitationsTable.email}) = ${email}`, sql`${invitationsTable.expiresAt} <= ${now}`));
    const [member] = await tx.select({ id: membershipsTable.id }).from(membershipsTable).innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .where(and(eq(membershipsTable.organizationId, tenant.organizationId), sql`lower(${usersTable.email}) = ${email}`)).limit(1);
    if (member) throw new InvitationConflictError();
    const [existing] = await tx.select({ id: invitationsTable.id }).from(invitationsTable).where(and(eq(invitationsTable.organizationId, tenant.organizationId), sql`lower(${invitationsTable.email}) = ${email}`, isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt), gt(invitationsTable.expiresAt, now))).limit(1);
    if (existing) throw new InvitationConflictError();
    const [group] = await tx.select({ id: permissionGroupsTable.id, name: permissionGroupsTable.name }).from(permissionGroupsTable).where(and(eq(permissionGroupsTable.id, input.groupId), eq(permissionGroupsTable.organizationId, tenant.organizationId))).limit(1);
    if (!group) throw new InvitationConflictError();
    const [{ members }] = await tx.select({ members: sql<number>`count(*)::int` }).from(membershipsTable).where(and(eq(membershipsTable.organizationId, tenant.organizationId), eq(membershipsTable.status, "active")));
    const [{ invites }] = await tx.select({ invites: sql<number>`count(*)::int` }).from(invitationsTable).where(and(eq(invitationsTable.organizationId, tenant.organizationId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt), gt(invitationsTable.expiresAt, now)));
    const limit = (await resolveEntitlements(tx, tenant.organizationId))["limits.max_users"];
    if (typeof limit !== "number" || !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0 || members + invites >= limit) throw new InvitationConflictError();
    const expiresAt = new Date(now.getTime() + 7 * 86400000);
    const [created] = await tx.insert(invitationsTable).values({ organizationId: tenant.organizationId, email, groupId: group.id, tokenHash, invitedByUserId: tenant.userId, expiresAt }).returning({ id: invitationsTable.id });
    const [workspace] = await tx.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, tenant.organizationId)).limit(1);
    return { id: created!.id, groupId: group.id, role: group.name, expiresAt, workspaceName: workspace?.name ?? runtimeConfig.productName };
  });
  try {
    await delivery.deliverInvitation({ recipientEmail: email, productName: runtimeConfig.productName, workspaceName: pending.workspaceName, expiresAt: pending.expiresAt, acceptUrl: `https://${runtimeConfig.appDomain}/invitations/accept?token=${encodeURIComponent(token)}` });
  } catch {
    await withTenantDb(tenant, async (tx) => { await lock(tx, tenant.organizationId); await tx.update(invitationsTable).set({ revokedAt: new Date() }).where(and(eq(invitationsTable.id, pending.id), eq(invitationsTable.organizationId, tenant.organizationId), isNull(invitationsTable.acceptedAt))); });
    throw new InvitationUnavailableError();
  }
  try {
    await withTenantDb(tenant, async (tx) => {
      await lock(tx, tenant.organizationId);
      const [delivered] = await tx.update(invitationsTable).set({ deliveredAt: new Date() }).where(and(
        eq(invitationsTable.id, pending.id),
        eq(invitationsTable.organizationId, tenant.organizationId),
        isNull(invitationsTable.acceptedAt),
        isNull(invitationsTable.revokedAt),
      )).returning({ id: invitationsTable.id });
      if (!delivered) throw new InvitationUnavailableError();
      await writeAuditEvent(tx, { organizationId: tenant.organizationId, actor: auditUser(tenant.userId), action: "invitation.created", category: "members", subject: { type: "invitation", id: pending.id, label: "invited" }, afterState: { groupId: pending.groupId }, requestId });
    });
  } catch {
    await withTenantDb(tenant, async (tx) => {
      await lock(tx, tenant.organizationId);
      await tx.update(invitationsTable).set({ revokedAt: new Date() }).where(and(
        eq(invitationsTable.id, pending.id),
        eq(invitationsTable.organizationId, tenant.organizationId),
        isNull(invitationsTable.acceptedAt),
      ));
    }).catch(() => undefined);
    throw new InvitationUnavailableError();
  }
  return { id: pending.id, email, groupId: pending.groupId, role: pending.role, status: "invited" as const, expiresAt: pending.expiresAt };
}

export async function acceptInvitation(user: { id: string; email: string }, token: string, requestId?: string) {
  if (!isInvitationToken(token)) throw new InvitationConflictError();
  const tokenHash = hashInvitationToken(token);
  const email = normalizeInvitationEmail(user.email);
  const invite = await lookupAcceptableInvitation(token, email);
  if (!invite) throw new InvitationConflictError();
  try {
    return await withTenantDb({ organizationId: invite.organizationId, userId: user.id }, async (tx) => {
      await lock(tx, invite.organizationId);
      const [current] = await tx.select().from(invitationsTable).where(and(eq(invitationsTable.id, invite.invitationId), eq(invitationsTable.organizationId, invite.organizationId), eq(invitationsTable.tokenHash, tokenHash), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt), gt(invitationsTable.expiresAt, new Date()), sql`${invitationsTable.deliveredAt} is not null`, sql`lower(${invitationsTable.email}) = ${email}`)).limit(1);
      const [org] = await tx.select({ id: organizationsTable.id }).from(organizationsTable).where(and(eq(organizationsTable.id, invite.organizationId), eq(organizationsTable.status, "active"))).limit(1);
      const [group] = current ? await tx.select({ id: permissionGroupsTable.id }).from(permissionGroupsTable).where(and(eq(permissionGroupsTable.id, current.groupId), eq(permissionGroupsTable.organizationId, invite.organizationId))).limit(1) : [];
      if (!current || !org || !group) throw new InvitationConflictError();
      const [membership] = await tx.select().from(membershipsTable).where(and(eq(membershipsTable.organizationId, invite.organizationId), eq(membershipsTable.userId, user.id))).limit(1);
      if (membership?.status === "active") throw new InvitationConflictError();
      if (membership) await tx.update(membershipsTable).set({ groupId: group.id, status: "active" }).where(and(eq(membershipsTable.id, membership.id), eq(membershipsTable.organizationId, invite.organizationId)));
      else await tx.insert(membershipsTable).values({ organizationId: invite.organizationId, userId: user.id, groupId: group.id, status: "active" });
      const [accepted] = await tx.update(invitationsTable).set({ acceptedAt: new Date(), acceptedByUserId: user.id }).where(and(eq(invitationsTable.id, invite.invitationId), eq(invitationsTable.organizationId, invite.organizationId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt))).returning({ id: invitationsTable.id });
      if (!accepted) throw new InvitationConflictError();
      await writeAuditEvent(tx, { organizationId: invite.organizationId, actor: auditUser(user.id), action: "invitation.accepted", category: "members", subject: { type: "invitation", id: invite.invitationId, label: "accepted" }, requestId });
      return { organizationId: invite.organizationId };
    });
  } catch (error) { if (error instanceof InvitationConflictError || uniqueViolation(error)) throw new InvitationConflictError(); throw error; }
}

export async function revokeInvitation(tenant: TenantContext, invitationId: string, requestId?: string) {
  return withTenantDb(tenant, async (tx) => {
    await lock(tx, tenant.organizationId);
    const [row] = await tx.update(invitationsTable).set({ revokedAt: new Date() }).where(and(
      eq(invitationsTable.id, invitationId), eq(invitationsTable.organizationId, tenant.organizationId),
      isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt),
    )).returning({ id: invitationsTable.id });
    if (!row) throw new InvitationConflictError();
    await writeAuditEvent(tx, { organizationId: tenant.organizationId, actor: auditUser(tenant.userId), action: "invitation.revoked", category: "members", subject: { type: "invitation", id: row.id, label: "revoked" }, requestId });
  });
}

export async function reissueInvitation(
  tenant: TenantContext,
  invitationId: string,
  delivery?: InvitationDelivery,
  requestId?: string,
) {
  if (!delivery) throw new InvitationUnavailableError();
  const prior = await withTenantDb(tenant, async (tx) => {
    await lock(tx, tenant.organizationId);
    const [row] = await tx.update(invitationsTable).set({ revokedAt: new Date() }).where(and(
      eq(invitationsTable.id, invitationId), eq(invitationsTable.organizationId, tenant.organizationId),
      isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt),
    )).returning({ email: invitationsTable.email, groupId: invitationsTable.groupId });
    if (!row) throw new InvitationConflictError();
    await writeAuditEvent(tx, { organizationId: tenant.organizationId, actor: auditUser(tenant.userId), action: "invitation.revoked", category: "members", subject: { type: "invitation", id: invitationId, label: "revoked for reissue" }, requestId });
    return row;
  });
  const replacement = await issueInvitation(tenant, prior, delivery, requestId);
  await withTenantDb(tenant, async (tx) => writeAuditEvent(tx, {
    organizationId: tenant.organizationId,
    actor: auditUser(tenant.userId),
    action: "invitation.reissued",
    category: "members",
    subject: { type: "invitation", id: replacement.id, label: "reissued" },
    metadata: { replacesInvitationId: invitationId },
    requestId,
  }));
  return replacement;
}