import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PgBoss, type Job } from "pg-boss";
import { auditLogsTable, db, organizationsTable, plansTable, providerAccountsTable, providerTenantSpacesTable } from "@workspace/db";
import { encryptProviderCredentials } from "./lib/credential-encryption";
import { finalizeProviderTenantSpaceProvisioning, provisionTenantOrganization } from "./lib/tenant-provisioning";
import { Step7SmokeVideoProvider } from "@workspace/providers/test-only";

const suffix = randomUUID();
const planCode = `step7-smoke-${suffix}`;
let organizationId: string | undefined;
let accountId: string | undefined;
const testProvider = new Step7SmokeVideoProvider();
const queueName = `vid.tenant.provision.smoke.${suffix}`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const boss = new PgBoss({ connectionString, schema: "vid_jobs", migrate: false, application_name: "vid-step7-smoke" });

try {
  const [plan] = await db.insert(plansTable).values({
    code: planCode, name: "Step 7 smoke", storageLimitGb: 1, entitlements: {},
  }).returning();
  const [account] = await db.insert(providerAccountsTable).values({
    providerKey: "step7-smoke", label: `Smoke ${suffix}`, encryptedCredentials: encryptProviderCredentials({ account: "test-only" }),
    maxZones: 2, zoneCountCached: 0, acceptingNewTenants: true,
  }).returning();
  accountId = account.id;
  const [organization] = await db.insert(organizationsTable).values({
    name: "Step 7 smoke organization", slug: `step7-${suffix}`, planId: plan.id,
  }).returning();
  organizationId = organization.id;
  await boss.start();
  await boss.createQueue(queueName, { retryLimit: 0, expireInSeconds: 30, retentionSeconds: 60 });
  await boss.work<{ organizationId: string }>(
    queueName,
    { batchSize: 1 },
    async ([job]: Job<{ organizationId: string }>[]) => provisionTenantOrganization(
      job.data.organizationId,
      async () => testProvider,
    ),
  );
  const first = await boss.send(queueName, { organizationId: organization.id });
  const second = await boss.send(queueName, { organizationId: organization.id });
  if (!first || !second) throw new Error("Smoke queue rejected a provisioning job");
  const deadline = Date.now() + 20_000;
  let completed = false;
  while (Date.now() < deadline) {
    const jobs = await Promise.all([first, second].map((id) => boss.findJobs(queueName, { id })
      .then(([job]) => job)));
    if (jobs.some((job) => job?.state === "failed")) throw new Error("Tenant provisioning job failed");
    if (jobs.length === 2 && jobs.every((job) => job?.state === "completed")) {
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!completed) throw new Error("Timed out waiting for tenant provisioning jobs");
  const [activeOrganization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organization.id));
  const spaces = await db.select().from(providerTenantSpacesTable)
    .where(and(eq(providerTenantSpacesTable.organizationId, organization.id), eq(providerTenantSpacesTable.state, "created")));
  if (activeOrganization?.status !== "active" || spaces.length !== 1) {
    throw new Error("Idempotency assertion failed: expected one tenant space and active organization");
  }
  const successAudits = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organization.id),
    eq(auditLogsTable.action, "provider.account_provisioning.succeeded"),
  ));
  if (successAudits.length !== 1) throw new Error("Expected exactly one provisioning success audit");
  await finalizeProviderTenantSpaceProvisioning(organization.id, spaces[0]!.id);
  const repeatedAudits = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organization.id),
    eq(auditLogsTable.action, "provider.account_provisioning.succeeded"),
  ));
  if (repeatedAudits.length !== 1) throw new Error("Idempotent finalization duplicated its success audit");

  await db.update(providerTenantSpacesTable).set({ state: "creating" }).where(eq(providerTenantSpacesTable.id, spaces[0]!.id));
  await finalizeProviderTenantSpaceProvisioning(
    organization.id,
    spaces[0]!.id,
    async () => { throw new Error("deterministic_audit_insert_failure"); },
  ).then(() => { throw new Error("Expected audit insertion failure"); }, () => undefined);
  const [rolledBack] = await db.select({ state: providerTenantSpacesTable.state })
    .from(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.id, spaces[0]!.id));
  if (rolledBack?.state !== "creating") throw new Error("Audit failure did not roll back provider-space transition");
  await finalizeProviderTenantSpaceProvisioning(organization.id, spaces[0]!.id);
  const postRollbackAudits = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organization.id),
    eq(auditLogsTable.action, "provider.account_provisioning.succeeded"),
  ));
  if (postRollbackAudits.length !== 2) throw new Error("Successful transition after rollback did not create one audit");
  console.log(JSON.stringify({ organizationId: organization.id, tenantSpaces: spaces.length, status: activeOrganization.status }));
} finally {
  await boss.stop({ graceful: true, timeout: 5_000 });
  if (organizationId) {
    await db.delete(auditLogsTable).where(eq(auditLogsTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
  if (accountId) await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(plansTable).where(eq(plansTable.code, planCode));
}