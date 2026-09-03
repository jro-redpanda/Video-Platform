import {
  db,
  groupPermissionsTable,
  membershipsTable,
  onboardingProvisioningIntentsTable,
  organizationCustomizationTable,
  organizationsTable,
  permissionGroupsTable,
  permissionsTable,
  plansTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditUser, writeAuditEvent } from "./audit";
import type { TenantTransaction } from "./tenant-db";
import { runtimeConfig } from "./config";

const permissionCatalog = [
  ["workspace.manage", "Manage workspace settings and branding"],
  ["videos.read", "View the video library"],
  ["videos.create", "Create videos and upload media"],
  ["videos.update", "Edit video metadata and visibility"],
  ["videos.delete", "Delete videos and provider media"],
  ["members.manage", "Invite, suspend, and assign members"],
  ["analytics.read", "View workspace analytics"],
  ["audit.read", "View the immutable audit trail"],
  ["audit.export", "Export the immutable audit trail"],
] as const;

const defaultGroups = [
  { name: "Owners", description: "Full workspace access", permissions: permissionCatalog.map(([key]) => key) },
  { name: "Editors", description: "Create and manage videos", permissions: ["videos.read", "videos.create", "videos.update", "videos.delete", "analytics.read"] },
  { name: "Viewers", description: "View videos and analytics", permissions: ["videos.read", "analytics.read"] },
] as const;

const reservedSlugs = new Set([
  "admin", "api", "app", "auth", "billing", "help", "onboarding", "public",
  "settings", "support", "system", "www",
]);

export class OnboardingConflictError extends Error {}
export class OnboardingValidationError extends Error {}
export class OnboardingForbiddenError extends Error {}

function hasPostgresCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: string }).code === code) return true;
  return "cause" in error && hasPostgresCode((error as { cause?: unknown }).cause, code);
}

export function normalizeWorkspaceInput(input: { name: string; slug?: string }) {
  const name = input.name.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new OnboardingValidationError("Workspace name must be between 2 and 100 characters");
  }
  const source = input.slug ?? name;
  const slug = source.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (slug.length < 2 || slug.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new OnboardingValidationError("Workspace slug must normalize to 2–63 lower-case letters, numbers, or hyphens");
  }
  if (reservedSlugs.has(slug)) throw new OnboardingValidationError("Workspace slug is reserved");
  return { name, slug };
}

export async function seedWorkspaceDefaults(tx: TenantTransaction, organizationId: string, organizationName?: string) {
  await tx.insert(permissionsTable).values(
    permissionCatalog.map(([key, description]) => ({ key, description })),
  ).onConflictDoNothing();
  const displayName = organizationName ?? runtimeConfig.productName;
  const logoInitials = Array.from(displayName).find((character) => /[\p{Letter}\p{Number}]/u.test(character))?.toUpperCase()
    ?? Array.from(runtimeConfig.productName)[0]?.toUpperCase()
    ?? "";
  await tx.insert(organizationCustomizationTable).values({ organizationId, logoInitials }).onConflictDoNothing();
  const groupIds = new Map<string, string>();
  for (const group of defaultGroups) {
    const [inserted] = await tx.insert(permissionGroupsTable).values({
      organizationId, name: group.name, description: group.description,
    }).onConflictDoNothing().returning({ id: permissionGroupsTable.id });
    const [existing] = inserted ? [inserted] : await tx.select({ id: permissionGroupsTable.id })
      .from(permissionGroupsTable).where(and(
        eq(permissionGroupsTable.organizationId, organizationId),
        eq(permissionGroupsTable.name, group.name),
      )).limit(1);
    if (!existing) throw new Error("Unable to seed workspace permission groups");
    groupIds.set(group.name, existing.id);
    await tx.insert(groupPermissionsTable).values(
      group.permissions.map((permissionKey) => ({ groupId: existing.id, permissionKey })),
    ).onConflictDoNothing();
  }
  return { ownerGroupId: groupIds.get("Owners")! };
}

export async function createFirstWorkspace(userId: string, raw: { name: string; slug?: string }) {
  const input = normalizeWorkspaceInput(raw);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace-onboarding:${userId}`}))`);
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      const [membership] = await tx.select({ id: membershipsTable.id }).from(membershipsTable)
        .where(eq(membershipsTable.userId, userId)).limit(1);
      if (membership) throw new OnboardingConflictError("A workspace already exists for this account");
      const [plan] = await tx.select({ id: plansTable.id }).from(plansTable)
        .where(and(eq(plansTable.code, "growth"), eq(plansTable.active, true))).limit(1);
      if (!plan) throw new Error("The default workspace plan is not configured");
      const [organization] = await tx.insert(organizationsTable).values({
        name: input.name, slug: input.slug, status: "provisioning", planId: plan.id,
      }).returning();
      if (!organization) throw new Error("Unable to create workspace");
      await tx.execute(sql`select set_config('app.organization_id', ${organization.id}, true)`);
      const { ownerGroupId } = await seedWorkspaceDefaults(tx, organization.id, organization.name);
      await tx.insert(membershipsTable).values({
        organizationId: organization.id, userId, groupId: ownerGroupId, status: "active",
      });
      await tx.insert(onboardingProvisioningIntentsTable).values({
        organizationId: organization.id, requestedByUserId: userId, state: "pending", retryable: true,
      });
      await writeAuditEvent(tx, {
        organizationId: organization.id,
        actor: auditUser(userId),
        action: "workspace.onboarding_requested",
        category: "workspace",
        subject: { type: "organization", id: organization.id, label: organization.name },
        afterState: { status: "provisioning" },
      });
      return organization;
    });
  } catch (error) {
    if (error instanceof OnboardingConflictError) throw error;
    if (hasPostgresCode(error, "23505")) {
      throw new OnboardingConflictError("Workspace slug is unavailable");
    }
    throw error;
  }
}

async function findOwnedOnboarding(userId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const [row] = await tx.select({
      membershipId: membershipsTable.id,
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      status: organizationsTable.status,
      intentId: onboardingProvisioningIntentsTable.id,
      intentState: onboardingProvisioningIntentsTable.state,
      retryable: onboardingProvisioningIntentsTable.retryable,
      attempts: onboardingProvisioningIntentsTable.attempts,
      requestedByUserId: onboardingProvisioningIntentsTable.requestedByUserId,
    }).from(membershipsTable)
      .innerJoin(organizationsTable, eq(organizationsTable.id, membershipsTable.organizationId))
      .leftJoin(onboardingProvisioningIntentsTable, eq(onboardingProvisioningIntentsTable.organizationId, organizationsTable.id))
      .where(eq(membershipsTable.userId, userId))
      .orderBy(membershipsTable.createdAt)
      .limit(1);
    return row;
  });
}

export async function getOnboardingState(userId: string) {
  return toOnboardingResponse(await findOwnedOnboarding(userId));
}

export async function retryWorkspaceOnboarding(userId: string, workspaceId?: string) {
  const owned = await findOwnedOnboarding(userId);
  if (!owned || (workspaceId && workspaceId !== owned.id)) {
    throw new OnboardingForbiddenError("Only the workspace owner may retry provisioning");
  }
  if (owned.requestedByUserId !== userId) {
    throw new OnboardingForbiddenError("Only the workspace owner may retry provisioning");
  }
  if (!owned.intentId || owned.status === "active" || owned.status === "suspended"
    || owned.intentState === "completed" || owned.intentState === "reconciliation_required"
    || owned.retryable === false || (owned.attempts ?? 0) >= 5) {
    throw new OnboardingConflictError("Workspace provisioning cannot be retried in its current state");
  }
  if (owned.intentState === "failed" || owned.intentState === "unavailable") {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await tx.execute(sql`select set_config('app.organization_id', ${owned.id}, true)`);
      await tx.update(onboardingProvisioningIntentsTable).set({
        state: "pending", dispatchClaim: null, claimedAt: null, diagnosticCode: null,
      }).where(and(
        eq(onboardingProvisioningIntentsTable.id, owned.intentId!),
        eq(onboardingProvisioningIntentsTable.requestedByUserId, userId),
        inArray(onboardingProvisioningIntentsTable.state, ["failed", "unavailable"]),
        eq(onboardingProvisioningIntentsTable.retryable, true),
      ));
      await tx.update(organizationsTable).set({ status: "provisioning" }).where(eq(organizationsTable.id, owned.id));
    });
  }
  return getOnboardingState(userId);
}

type OwnedOnboarding = Awaited<ReturnType<typeof findOwnedOnboarding>>;
function toOnboardingResponse(row: OwnedOnboarding) {
  if (!row) return {
    state: "needs_workspace" as const,
    provisioning: { state: "pending" as const, retryable: false, message: "Create a workspace to continue." },
  };
  const workspace = { id: row.id, name: row.name, slug: row.slug, status: row.status };
  if (row.status === "active") return {
    state: "active" as const, workspace,
    provisioning: { state: "ready" as const, retryable: false, message: "Workspace is ready." },
  };
  if (row.status === "suspended") return {
    state: "suspended" as const, workspace,
    provisioning: { state: "failed" as const, retryable: false, message: "Workspace access is suspended." },
  };
  if (row.intentState === "reconciliation_required") return {
    state: "failed" as const, workspace,
    provisioning: { state: "reconciliation_required" as const, retryable: false, message: "Provisioning requires support review." },
  };
  if (row.intentState === "unavailable") return {
    state: "failed" as const, workspace,
    provisioning: { state: "unavailable" as const, retryable: row.retryable ?? false, message: "Workspace provisioning is temporarily unavailable." },
  };
  if (row.status === "failed" || row.intentState === "failed") return {
    state: "failed" as const, workspace,
    provisioning: { state: "failed" as const, retryable: row.retryable ?? false, message: "Workspace provisioning did not complete." },
  };
  return {
    state: "provisioning" as const, workspace,
    provisioning: {
      state: row.intentState === "processing" ? "creating" as const : "pending" as const,
      retryable: true,
      message: row.intentState === "processing" ? "Workspace services are being created." : "Workspace provisioning is queued.",
    },
  };
}