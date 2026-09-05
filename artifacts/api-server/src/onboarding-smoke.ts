import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV !== "test") throw new Error("onboarding smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const { and, eq, inArray } = await import("drizzle-orm");
const {
  auditLogsTable, db, groupPermissionsTable, membershipsTable,
  onboardingProvisioningIntentsTable, organizationsTable, permissionGroupsTable,
  providerAccountsTable, providerTenantSpacesTable, sessionsTable, usersTable,
} = await import("@workspace/db");
const { Step7SmokeVideoProvider } = await import("@workspace/providers/test-only");
const { default: app } = await import("./app");
const {
  dispatchPendingOnboardingIntents, processOnboardingProvisioningJob,
} = await import("./lib/jobs");
const { ProvisioningUnavailableError } = await import("./lib/tenant-provisioning");

const marker = randomUUID();
const emails = [
  `onboarding-a-${marker}@example.test`,
  `onboarding-b-${marker}@example.test`,
  `onboarding-c-${marker}@example.test`,
  `onboarding-d-${marker}@example.test`,
];
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
  const { decryptProviderCredentials, encryptProviderCredentials } = await import("./lib/credential-encryption");
  const credentialEnvelope = encryptProviderCredentials({
    accountApiKey: `account-${marker}`,
    readOnlyApiKey: `read-${marker}`,
  });
  assert.deepEqual(decryptProviderCredentials(credentialEnvelope), {
    accountApiKey: `account-${marker}`,
    readOnlyApiKey: `read-${marker}`,
  });
  const envelopeParts = credentialEnvelope.split(".");
  const ciphertext = envelopeParts[3]!;
  const tamperIndex = Math.floor(ciphertext.length / 2);
  envelopeParts[3] = `${ciphertext.slice(0, tamperIndex)}${ciphertext[tamperIndex] === "A" ? "B" : "A"}${ciphertext.slice(tamperIndex + 1)}`;
  assert.throws(
    () => decryptProviderCredentials(envelopeParts.join(".")),
    /authentication/,
  );
  assert.throws(() => decryptProviderCredentials("v1.A.A.A"), /Malformed/);
  assert.throws(() => encryptProviderCredentials({}), /Invalid provider credential payload/);
  assert.throws(() => encryptProviderCredentials({ empty: "" }), /Invalid provider credential payload/);
  const nearLimitCredentials = {
    a: "a".repeat(12_000),
    b: "b".repeat(12_000),
    c: "c".repeat(12_000),
    d: "d".repeat(12_000),
  };
  assert.deepEqual(
    decryptProviderCredentials(encryptProviderCredentials(nearLimitCredentials)),
    nearLimitCredentials,
  );
  assert.throws(() => encryptProviderCredentials({
    a: "a".repeat(12_250),
    b: "b".repeat(12_250),
    c: "c".repeat(12_250),
    d: "d".repeat(12_250),
  }), /too large/);
  const originalSessionSecret = process.env.SESSION_SECRET!;
  try {
    process.env.SESSION_SECRET = `${originalSessionSecret}-rotation-check`;
    assert.throws(() => decryptProviderCredentials(credentialEnvelope), /authentication/);
  } finally {
    process.env.SESSION_SECRET = originalSessionSecret;
  }

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
  assert.equal((await request("/api/onboarding/retry", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: organization!.id, unexpected: true }),
  }, first.cookie)).status, 400);
  assert.equal((await request("/api/onboarding/retry", {
    method: "POST", headers: { "content-type": "application/json" },
    body: "[]",
  }, first.cookie)).status, 400);
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
  let [queuedIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(queuedIntent?.attempts, 0, "publishing does not consume a provider attempt");
  const firstDeliveryId = (sent[0]!.options as { id: string }).id;
  assert.match(firstDeliveryId, new RegExp(`^${queuedIntent!.id}:`));

  await db.update(onboardingProvisioningIntentsTable).set({ state: "pending" })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  const rejectedQueue = { send: async () => { throw new Error("queue unavailable"); }, findJobs: async () => [] };
  for (let index = 0; index < 6; index++) {
    assert.equal((await dispatchPendingOnboardingIntents(rejectedQueue as never)).dispatched, 0);
  }
  [queuedIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(queuedIntent?.state, "pending");
  assert.equal(queuedIntent?.attempts, 0, "enqueue outages cannot exhaust provider attempts");
  assert.equal(sent.length, 1, "enqueue failures do not produce a retry storm");
  assert.equal((await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched, 1);
  const secondDeliveryId = (sent[1]!.options as { id: string }).id;
  assert.notEqual(secondDeliveryId, firstDeliveryId, "a later durable delivery uses a fresh queue identity");

  await db.update(onboardingProvisioningIntentsTable).set({
    state: "processing",
    claimedAt: new Date(Date.now() - 26 * 60_000),
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(
    (await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched,
    1,
    "a processing claim older than the queue execution horizon is redispatched",
  );

  await db.update(onboardingProvisioningIntentsTable).set({
    state: "pending",
    attempts: 5,
    retryable: true,
    claimedAt: null,
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal((await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched, 0);
  [queuedIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(queuedIntent?.state, "failed");
  assert.equal(queuedIntent?.retryable, false, "exhausted durable work becomes terminal instead of remaining hidden");
  await db.update(organizationsTable).set({ status: "provisioning" })
    .where(eq(organizationsTable.id, organization!.id));
  await db.update(onboardingProvisioningIntentsTable).set({
    state: "queued",
    attempts: 0,
    retryable: true,
    diagnosticCode: null,
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));

  const [account] = await db.insert(providerAccountsTable).values({
    providerKey: "step7-smoke", label: `Onboarding ${marker}`,
    encryptedCredentials: "test-only-not-a-production-credential",
    maxZones: 8, zoneCountCached: 0, acceptingNewTenants: true,
  }).returning();
  accountIds.push(account!.id);
  const fakeProvider = new Step7SmokeVideoProvider();
  const provisioning = processOnboardingProvisioningJob(organization!.id, async () => fakeProvider);
  const duplicate = processOnboardingProvisioningJob(organization!.id, async () => fakeProvider);
  const provisioningResults = await Promise.all([provisioning, duplicate]);
  assert.equal(provisioningResults.filter((result) => "skipped" in result).length, 1);
  assert.equal(fakeProvider.callbackConfigurationCalls, 1);
  assert.equal(
    fakeProvider.lastConfiguredCallbackUrl,
    "https://callbacks.test.invalid/provider/encode",
  );
  const active = await request("/api/onboarding", {}, first.cookie);
  const activeBody = await active.json() as { state: string; provisioning: { state: string }; workspace: Record<string, unknown> };
  assert.equal(activeBody.state, "active");
  assert.equal(activeBody.provisioning.state, "ready");
  assert.deepEqual(Object.keys(activeBody.workspace).sort(), ["id", "name", "slug", "status"]);
  await db.update(providerTenantSpacesTable).set({ reconciliationRequired: true })
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  const inconsistentActive = await request("/api/onboarding", {}, first.cookie);
  const inconsistentActiveBody = await inconsistentActive.json() as {
    state: string;
    provisioning: { state: string; retryable: boolean; message: string };
  };
  assert.equal(inconsistentActiveBody.state, "failed", "active status alone cannot produce a ready UI");
  assert.deepEqual(inconsistentActiveBody.provisioning, {
    state: "reconciliation_required",
    retryable: false,
    message: "Provisioning requires support review.",
  });
  await db.update(providerTenantSpacesTable).set({ reconciliationRequired: false })
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  assert.equal((await request("/api/onboarding/retry", { method: "POST" }, first.cookie)).status, 409);

  const conflict = await request("/api/onboarding/workspaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Other", slug: "cafe-launch" }),
  }, second.cookie);
  assert.equal(conflict.status, 409);
  assert.equal((await db.select().from(membershipsTable).where(eq(membershipsTable.userId, second.user.id))).length, 0);

  // Callback configuration occurs under the external-call claim. An ambiguous
  // outcome preserves the provider ID and requires reconciliation.
  await db.update(organizationsTable).set({ status: "provisioning" }).where(eq(organizationsTable.id, organization!.id));
  await db.update(onboardingProvisioningIntentsTable).set({ state: "queued", retryable: true })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  await db.delete(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  const callbackFailureProvider = new Step7SmokeVideoProvider();
  callbackFailureProvider.failNextCallbackConfiguration = true;
  await processOnboardingProvisioningJob(
    organization!.id,
    async () => callbackFailureProvider,
  ).then(() => assert.fail("callback-configuration failure succeeded"), () => undefined);
  const [reconciliationSpace] = await db.select().from(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  assert.ok(reconciliationSpace?.providerSpaceId);
  assert.equal(reconciliationSpace?.reconciliationRequired, true);
  assert.ok(reconciliationSpace?.externalCallClaim);
  const [reconciliationIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(reconciliationIntent?.state, "reconciliation_required");
  assert.equal(reconciliationIntent?.retryable, false);

  // A stale external-call claim is quarantined without dispatching another
  // provider attempt. A fresh external claim remains active even if the outer
  // processing timestamp is older.
  await db.update(organizationsTable).set({ status: "provisioning" })
    .where(eq(organizationsTable.id, organization!.id));
  await db.update(onboardingProvisioningIntentsTable).set({
    state: "processing",
    attempts: 1,
    retryable: true,
    claimedAt: new Date(Date.now() - 26 * 60_000),
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  const freshExternalClaim = randomUUID();
  await db.update(providerTenantSpacesTable).set({
    providerSpaceId: null,
    state: "creating",
    reconciliationRequired: false,
    externalCallClaim: freshExternalClaim,
    externalCallClaimedAt: new Date(),
  }).where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  assert.equal((await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched, 0);
  let [activeClaimIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(activeClaimIntent?.state, "processing");
  await db.update(onboardingProvisioningIntentsTable).set({
    claimedAt: new Date(Date.now() - 26 * 60_000),
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  await db.update(providerTenantSpacesTable).set({
    externalCallClaimedAt: new Date(Date.now() - 26 * 60_000),
  }).where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  assert.equal((await dispatchPendingOnboardingIntents(fakeQueue as never)).dispatched, 0);
  [activeClaimIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(activeClaimIntent?.state, "reconciliation_required");
  const [ambiguousSpace] = await db.select().from(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  assert.equal(ambiguousSpace?.reconciliationRequired, true);

  // A resolver failure occurs before an external call and is safely retryable.
  await db.update(organizationsTable).set({ status: "provisioning" }).where(eq(organizationsTable.id, organization!.id));
  await db.update(onboardingProvisioningIntentsTable).set({ state: "queued", retryable: true })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  await db.delete(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.organizationId, organization!.id));
  await processOnboardingProvisioningJob(organization!.id, async () => {
    throw new ProvisioningUnavailableError("test provider unavailable");
  }).then(() => assert.fail("provider-unavailable job succeeded"), () => undefined);
  const [failedIntent] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, organization!.id));
  assert.equal(failedIntent?.state, "unavailable");
  assert.equal(failedIntent?.retryable, true);

  // Provisioning may not overwrite a concurrent suspension during the provider
  // call, and the failure handler must preserve that administrative state.
  const third = await signUp(2);
  const thirdCreate = await request("/api/onboarding/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Suspension race", slug: `suspension-${marker}` }),
  }, third.cookie);
  assert.equal(thirdCreate.status, 202);
  const [thirdMembership] = await db.select().from(membershipsTable)
    .where(eq(membershipsTable.userId, third.user.id));
  assert(thirdMembership);
  organizationIds.push(thirdMembership.organizationId);
  await db.update(onboardingProvisioningIntentsTable).set({ state: "queued" })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, thirdMembership.organizationId));
  const suspensionProvider = new Step7SmokeVideoProvider();
  const originalConfigureCallback = suspensionProvider.setEncodeCompletionCallback.bind(suspensionProvider);
  suspensionProvider.setEncodeCompletionCallback = async (space, callbackUrl) => {
    await originalConfigureCallback(space, callbackUrl);
    await db.update(organizationsTable).set({ status: "suspended" })
      .where(eq(organizationsTable.id, thirdMembership.organizationId));
  };
  await processOnboardingProvisioningJob(
    thirdMembership.organizationId,
    async () => suspensionProvider,
  ).then(() => assert.fail("concurrent suspension was overwritten"), () => undefined);
  const [suspendedOrganization] = await db.select().from(organizationsTable)
    .where(eq(organizationsTable.id, thirdMembership.organizationId));
  assert.equal(suspendedOrganization?.status, "suspended");
  assert.equal((await request("/api/onboarding/retry", { method: "POST" }, third.cookie)).status, 409);

  await db.delete(providerTenantSpacesTable)
    .where(eq(providerTenantSpacesTable.organizationId, thirdMembership.organizationId));
  await db.update(organizationsTable).set({ status: "provisioning" })
    .where(eq(organizationsTable.id, thirdMembership.organizationId));
  await db.update(onboardingProvisioningIntentsTable).set({
    state: "queued",
    attempts: 0,
    retryable: true,
    diagnosticCode: null,
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, thirdMembership.organizationId));
  const ambiguousSuspensionProvider = new Step7SmokeVideoProvider();
  ambiguousSuspensionProvider.setEncodeCompletionCallback = async () => {
    await db.update(organizationsTable).set({ status: "suspended" })
      .where(eq(organizationsTable.id, thirdMembership.organizationId));
    throw new Error("test-only ambiguous callback outcome after suspension");
  };
  await processOnboardingProvisioningJob(
    thirdMembership.organizationId,
    async () => ambiguousSuspensionProvider,
  ).then(() => assert.fail("ambiguous callback outcome succeeded"), () => undefined);
  const [suspendedDuringReconciliation] = await db.select().from(organizationsTable)
    .where(eq(organizationsTable.id, thirdMembership.organizationId));
  assert.equal(suspendedDuringReconciliation?.status, "suspended");
  const [reconciliationAfterSuspension] = await db.select().from(onboardingProvisioningIntentsTable)
    .where(eq(onboardingProvisioningIntentsTable.organizationId, thirdMembership.organizationId));
  assert.equal(reconciliationAfterSuspension?.state, "reconciliation_required");

  // Owner retry and worker failure both acquire intent before organization, so
  // this overlap completes without a database deadlock or a 500 response.
  const fourth = await signUp(3);
  const fourthCreate = await request("/api/onboarding/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Retry race", slug: `retry-race-${marker}` }),
  }, fourth.cookie);
  assert.equal(fourthCreate.status, 202);
  const [fourthMembership] = await db.select().from(membershipsTable)
    .where(eq(membershipsTable.userId, fourth.user.id));
  assert(fourthMembership);
  organizationIds.push(fourthMembership.organizationId);
  await db.update(organizationsTable).set({ status: "failed" })
    .where(eq(organizationsTable.id, fourthMembership.organizationId));
  await db.update(onboardingProvisioningIntentsTable).set({
    state: "failed",
    attempts: 0,
    retryable: true,
  }).where(eq(onboardingProvisioningIntentsTable.organizationId, fourthMembership.organizationId));
  const retryRequest = request("/api/onboarding/retry", { method: "POST" }, fourth.cookie);
  const overlappingFailure = processOnboardingProvisioningJob(
    fourthMembership.organizationId,
    async () => {
      throw new ProvisioningUnavailableError("test-only concurrent provider failure");
    },
  ).catch(() => undefined);
  const [retryResponse] = await Promise.all([retryRequest, overlappingFailure]);
  assert.equal(retryResponse.status, 202);
  const [retryAudit] = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, fourthMembership.organizationId),
    eq(auditLogsTable.action, "workspace.onboarding_retry_requested"),
  ));
  assert.equal(retryAudit?.actorKind, "user");
  assert.equal(retryAudit?.actorUserId, fourth.user.id);
  assert.equal((retryAudit?.beforeState as { status?: string } | null)?.status, "failed");
  assert.equal((retryAudit?.afterState as { status?: string } | null)?.status, "provisioning");
  await db.update(organizationsTable).set({ status: "provisioning" })
    .where(eq(organizationsTable.id, fourthMembership.organizationId));
  await db.update(onboardingProvisioningIntentsTable).set({ state: "pending", retryable: true })
    .where(eq(onboardingProvisioningIntentsTable.organizationId, fourthMembership.organizationId));
  const retriesBeforeNoOp = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, fourthMembership.organizationId),
    eq(auditLogsTable.action, "workspace.onboarding_retry_requested"),
  ));
  assert.equal((await request("/api/onboarding/retry", { method: "POST" }, fourth.cookie)).status, 202);
  const retriesAfterNoOp = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, fourthMembership.organizationId),
    eq(auditLogsTable.action, "workspace.onboarding_retry_requested"),
  ));
  assert.equal(retriesAfterNoOp.length, retriesBeforeNoOp.length);
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