import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV !== "test") throw new Error("onboarding smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const { and, eq, inArray } = await import("drizzle-orm");
const {
  auditLogsTable, db, groupPermissionsTable, membershipsTable,
  onboardingProvisioningIntentsTable, organizationsTable, permissionGroupsTable,
  providerAccountsTable, sessionsTable, usersTable,
} = await import("@workspace/db");
const { Step7SmokeVideoProvider } = await import("@workspace/providers/test-only");
const { default: app } = await import("./app");
const {
  dispatchPendingOnboardingIntents, processOnboardingProvisioningJob,
} = await import("./lib/jobs");
const { ProvisioningUnavailableError } = await import("./lib/tenant-provisioning");

const marker = randomUUID();
const emails = [`onboarding-a-${marker}@example.test`, `onboarding-b-${marker}@example.test`];
const userIds: string[] = [];
const organizationIds: string[] = [];
const accountIds: string[] = [];
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function signUp(index: number) {
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Onboarding ${index}`, email: emails[index], password: `Onboarding-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, emails[index]!));
  assert(user); userIds.push(user.id);
  return { cookie, user };
}

const request = (path: string, init: RequestInit = {}, cookie?: string) => fetch(`${root}${path}`, {
  ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
});

try {
  assert.equal((await request("/api/onboarding")).status, 401);
  assert.equal((await request("/api/onboarding/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await request("/api/onboarding/retry", { method: "POST" })).status, 401);
  const first = await signUp(0);
  const second = await signUp(1);
  const empty = await request("/api/onboarding", {}, first.cookie);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json() as { state: string }).state, "needs_workspace");
  for (const slug of ["admin", "-", "a"]) {
    assert.equal((await request("/api/onboarding/workspaces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Valid workspace", slug }),
    }, first.cookie)).status, 400);
  }
  const create = () => request("/api/onboarding/workspaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "  Café   Launch  ", slug: " Café Launch " }),
  }, first.cookie);
  const concurrent = await Promise.all([create(), create()]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [202, 409]);
  const [membership] = await db.select().from(membershipsTable).where(eq(membershipsTable.userId, first.user.id));
  assert(membership); organizationIds.push(membership.organizationId);
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, membership.organizationId));
  assert.equal(organization?.slug, "cafe-launch");
  assert.equal(organization?.status, "provisioning");
  const [ownerGroup] = await db.select().from(permissionGroupsTable).where(eq(permissionGroupsTable.id, membership.groupId));
  assert.equal(ownerGroup?.name, "Owners");
  const ownerPermissions = await db.select().from(groupPermissionsTable).where(eq(groupPermissionsTable.groupId, membership.groupId));
  assert(ownerPermissions.some((row) => row.permissionKey === "workspace.manage"));
  const requested = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organization!.id),
    eq(auditLogsTable.action, "workspace.onboarding_requested"),
  ));
  assert.equal(requested.length, 1);
  assert.equal((await request("/api/onboarding", {}, second.cookie).then((r) => r.json()) as { state: string }).state, "needs_workspace");
  assert.equal((await request("/api/onboarding/retry", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: organization!.id }),
  }, second.cookie)).status, 403);
  assert.equal((await request("/api/onboarding/retry", { method: "POST" }, first.cookie)).status, 202);

  const sent: Array<{ name: string; data: unknown; options: unknown }> = [];
  const fakeQueue = {
    send: async (name: string, data: unknown, options: unknown) => {
      sent.push({ name, data, options }); return (options as { id: string }).id;
    },
    findJobs: async () => [],
  };
  assert.equal((await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched, 1);
  assert.equal(sent.length, 1, "durable intent was enqueued exactly once");

  const [account] = await db.insert(providerAccountsTable).values({
    providerKey: "step7-smoke", label: `Onboarding ${marker}`,
    encryptedCredentials: "test-only-not-a-production-credential",
    maxZones: 2, zoneCountCached: 0, acceptingNewTenants: true,
  }).returning();
  accountIds.push(account!.id);
  const fakeProvider = new Step7SmokeVideoProvider();
  await processOnboardingProvisioningJob(organization!.id, async () => fakeProvider);
  const active = await request("/api/onboarding", {}, first.cookie);
  const activeBody = await active.json() as { state: string; provisioning: { state: string }; workspace: Record<string, unknown> };
  assert.equal(activeBody.state, "active");
  assert.equal(activeBody.provisioning.state, "ready");
  assert.deepEqual(Object.keys(activeBody.workspace).sort(), ["id", "name", "slug", "status"]);
  assert.equal((await request("/api/onboarding/retry", { method: "POST" }, first.cookie)).status, 409);

  const conflict = await request("/api/onboarding/workspaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Other", slug: "cafe-launch" }),
  }, second.cookie);
  assert.equal(conflict.status, 409);
  assert.equal((await db.select().from(membershipsTable).where(eq(membershipsTable.userId, second.user.id))).length, 0);

  // A resolver failure occurs before an external call and is safely retryable.
  await db.update(organizationsTable).set({ status: "provisioning" }).where(eq(organizationsTable.id, organization!.id));
  await db.update(onboardingProvisioningIntentsTable).set({ state: "queued", retryable: true })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  await db.delete((await import("@workspace/db")).providerTenantSpacesTable)
    .where(eq((await import("@workspace/db")).providerTenantSpacesTable.organizationId, organization!.id));
  await processOnboardingProvisioningJob(organization!.id, async () => {
    throw new ProvisioningUnavailableError("test provider unavailable");
  }).then(() => assert.fail("provider-unavailable job succeeded"), () => undefined);
  const [failedIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(failedIntent?.state, "unavailable");
  assert.equal(failedIntent?.retryable, true);
} finally {
  server.close();
  if (organizationIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.organizationId, organizationIds));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  }
  if (accountIds.length) await db.delete(providerAccountsTable).where(inArray(providerAccountsTable.id, accountIds));
  if (userIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
}