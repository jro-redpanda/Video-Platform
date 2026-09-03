import { randomUUID } from "node:crypto";
import {
  onboardingProvisioningIntentsTable, organizationsTable,
  providerAccountsTable, providerTenantSpacesTable,
} from "@workspace/db";
import { TenantSpaceCreationRejectedError, type VideoProvider } from "@workspace/providers";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { ProvisioningProviderResolver } from "./provider-registry";
import { auditJob, writeAuditEvent } from "./audit";
import { seedWorkspaceDefaults } from "./workspace-onboarding";
import { withWorkerDb } from "./worker-db";

export class ProvisioningUnavailableError extends Error {}

export async function provisionTenantOrganization(organizationId: string, resolveProvider: ProvisioningProviderResolver) {
  const [organization] = await withWorkerDb("onboarding", (tx) =>
    tx.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1));
  if (!organization) throw new Error(`Organization ${organizationId} does not exist`);
  if (organization.status === "active") return { organizationId, status: "active" as const };

  let space = await withWorkerDb("onboarding", async (tx) => {
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
    if (!account) throw new ProvisioningUnavailableError("provider_capacity_unavailable");
    const [reserved] = await tx.update(providerAccountsTable)
      .set({ zoneCountCached: sql`${providerAccountsTable.zoneCountCached} + 1` })
      .where(and(
        eq(providerAccountsTable.id, account.id),
        eq(providerAccountsTable.acceptingNewTenants, true),
        lt(providerAccountsTable.zoneCountCached, providerAccountsTable.maxZones),
      )).returning();
    if (!reserved) throw new ProvisioningUnavailableError("provider_capacity_changed");
    const [inserted] = await tx.insert(providerTenantSpacesTable).values({
      organizationId, providerAccountId: account.id, idempotencyKey: randomUUID(), state: "creating",
    }).returning();
    await writeAuditEvent(tx, {
      organizationId, actor: auditJob(), action: "provider.account_provisioning.requested", category: "provider",
      subject: { type: "provider_tenant_space", id: inserted.id, label: "creating" },
      afterState: { state: "creating" },
    });
    return inserted;
  });
  if (!space) throw new Error(`Unable to reserve tenant space for organization ${organizationId}`);

  if (space.state === "creating" && !space.providerSpaceId) {
    const claim = randomUUID();
    const [claimed] = await withWorkerDb("onboarding", (tx) =>
      tx.update(providerTenantSpacesTable).set({
        externalCallClaim: claim, externalCallClaimedAt: new Date(),
      }).where(and(
        eq(providerTenantSpacesTable.id, space.id),
        isNull(providerTenantSpacesTable.providerSpaceId),
        isNull(providerTenantSpacesTable.externalCallClaim),
      )).returning());
    if (!claimed) {
      // A surviving claim represents an interrupted external call. Repeating
      // it could create a second remote library, so reconciliation is required.
      await markReconciliationRequired(organizationId, space.id, "interrupted_external_call_claim");
      throw new Error(`Provider tenant-space creation requires reconciliation for ${organizationId}`);
    }
    space = claimed;
    const [account] = await withWorkerDb("onboarding", (tx) =>
      tx.select().from(providerAccountsTable).where(eq(providerAccountsTable.id, space.providerAccountId)).limit(1));
    if (!account) {
      await releaseUnclaimedReservation(space, "provider_account_missing");
      throw new ProvisioningUnavailableError("provider_account_unavailable");
    }
    let provider: VideoProvider;
    try {
      provider = await resolveProvider(account, space);
    } catch (error) {
      await releaseUnclaimedReservation(space, "provider_resolver_failed");
      throw new ProvisioningUnavailableError("provider_resolution_unavailable", { cause: error });
    }
    // Bunny persists its ID and credentials through its awaited internal
    // onLibraryCreated callback. Other providers can safely persist the ID here.
    let tenantSpace;
    try {
      tenantSpace = await provider.createTenantSpace({ name: organization.name });
    } catch (error) {
      if (error instanceof TenantSpaceCreationRejectedError) {
        await releaseUnclaimedReservation(space, "provider_tenant_space_rejected");
        throw error;
      }
      await markReconciliationRequired(organizationId, space.id, "provider_call_outcome_ambiguous");
      throw error;
    }
    space = await withWorkerDb("onboarding", async (tx) => {
      const [persisted] = await tx.update(providerTenantSpacesTable)
        .set({ providerSpaceId: tenantSpace.id, externalCallClaim: null, externalCallClaimedAt: null })
        .where(and(eq(providerTenantSpacesTable.id, space.id), eq(providerTenantSpacesTable.state, "creating"), eq(providerTenantSpacesTable.externalCallClaim, claim)))
        .returning();
      if (persisted) return persisted;
      const [current] = await tx.select().from(providerTenantSpacesTable)
        .where(eq(providerTenantSpacesTable.id, space.id)).limit(1);
      return current;
    });
  }
  if (space?.state === "creating" && space.providerSpaceId) {
    space = await finalizeProviderTenantSpaceProvisioning(organizationId, space.id) ?? space;
  }
  if (!space || space.state !== "created" || !space.providerSpaceId) throw new Error("Provider tenant space was not created");

  await withWorkerDb("onboarding", async (tx) => {
    await seedWorkspaceDefaults(tx, organizationId, organization.name);
    await tx.update(organizationsTable).set({ status: "active" }).where(eq(organizationsTable.id, organizationId));
    await tx.update(onboardingProvisioningIntentsTable).set({
      state: "completed", retryable: false, completedAt: new Date(), diagnosticCode: null,
    }).where(eq(onboardingProvisioningIntentsTable.organizationId, organizationId));
  });
  return { organizationId, status: "active" as const, providerSpaceId: space.providerSpaceId };
}

async function markReconciliationRequired(organizationId: string, tenantSpaceId: string, code: string) {
  await withWorkerDb("onboarding", async (tx) => {
    await tx.update(providerTenantSpacesTable).set({ reconciliationRequired: true })
      .where(eq(providerTenantSpacesTable.id, tenantSpaceId));
    await tx.update(organizationsTable).set({ status: "failed" })
      .where(eq(organizationsTable.id, organizationId));
    await tx.update(onboardingProvisioningIntentsTable).set({
      state: "reconciliation_required", retryable: false, diagnosticCode: code,
    }).where(eq(onboardingProvisioningIntentsTable.organizationId, organizationId));
    await writeAuditEvent(tx, {
      organizationId, actor: auditJob(), action: "provider.account_provisioning.reconciliation_required", category: "provider",
      subject: { type: "provider_tenant_space", id: tenantSpaceId, label: "reconciliation_required" },
      beforeState: { state: "creating" }, afterState: { state: "reconciliation_required" },
      metadata: { code },
    });
  });
}

/** Atomically publishes the provider space and its audit record. */
export async function finalizeProviderTenantSpaceProvisioning(
  organizationId: string,
  tenantSpaceId: string,
  auditWriter: typeof writeAuditEvent = writeAuditEvent,
) {
  return withWorkerDb("onboarding", async (tx) => {
    const [created] = await tx.update(providerTenantSpacesTable).set({ state: "created" })
      .where(and(
        eq(providerTenantSpacesTable.id, tenantSpaceId),
        eq(providerTenantSpacesTable.organizationId, organizationId),
        eq(providerTenantSpacesTable.state, "creating"),
      ))
      .returning();
    if (!created) {
      const [current] = await tx.select().from(providerTenantSpacesTable)
        .where(and(
          eq(providerTenantSpacesTable.id, tenantSpaceId),
          eq(providerTenantSpacesTable.organizationId, organizationId),
        )).limit(1);
      return current;
    }
    await auditWriter(tx, {
      organizationId, actor: auditJob(), action: "provider.account_provisioning.succeeded", category: "provider",
      subject: { type: "provider_tenant_space", id: created.id, label: "created" },
      beforeState: { state: "creating" }, afterState: { state: "created" },
    });
    return created;
  });
}

async function releaseUnclaimedReservation(space: typeof providerTenantSpacesTable.$inferSelect, code: string) {
  const [current] = await withWorkerDb("onboarding", (tx) =>
    tx.select().from(providerTenantSpacesTable)
      .where(eq(providerTenantSpacesTable.id, space.id)).limit(1));
  // Resolver failures happen before a remote call. If an external ID exists,
  // its outcome is ambiguous and the reservation intentionally remains.
  if (current?.providerSpaceId) return;
  await withWorkerDb("onboarding", async (tx) => {
    const [locked] = await tx.select({ id: providerTenantSpacesTable.id }).from(providerTenantSpacesTable)
      .where(and(eq(providerTenantSpacesTable.id, space.id), isNull(providerTenantSpacesTable.providerSpaceId)))
      .for("update").limit(1);
    if (!locked) return;
    await writeAuditEvent(tx, {
      organizationId: space.organizationId, actor: auditJob(), action: "provider.account_provisioning.failed", category: "provider",
      subject: { type: "provider_tenant_space", id: space.id, label: "released" },
      beforeState: { state: "creating" }, afterState: { state: "released" }, metadata: { code },
    });
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