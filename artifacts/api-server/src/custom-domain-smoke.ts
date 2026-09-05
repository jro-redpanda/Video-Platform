import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DomainDnsResolver } from "./lib/domain-dns-resolver";

if (process.env.NODE_ENV !== "test") throw new Error("custom-domain smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const { and, eq, inArray, or, sql } = await import("drizzle-orm");
const {
  accountsTable, auditLogsTable, customDomainsTable, customDomainVerificationWindowsTable,
  db, groupPermissionsTable, membershipsTable, organizationCustomizationTable,
  organizationsTable, permissionGroupsTable, permissionsTable, plansTable, sessionsTable, usersTable,
} = await import("@workspace/db");
const { default: app } = await import("./app");
const { normalizeHostname, processCustomDomainVerification } = await import("./lib/custom-domain");
const { repairCustomDomainVerifications, setCustomDomainVerificationEnqueuerForTest } = await import("./lib/jobs");

const marker = randomUUID();
const planYes = randomUUID(), planNo = randomUUID();
const orgA = randomUUID(), orgB = randomUUID(), orgNo = randomUUID();
const managerGroup = randomUUID(), memberGroup = randomUUID(), managerBGroup = randomUUID(), managerNoGroup = randomUUID();
const userIds: string[] = [];
const queued: string[] = [];
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const address = server.address(); assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;

async function user(label: string, organizationId: string, groupId: string) {
  const email = `custom-domain-${label}-${marker}@example.test`;
  const response = await fetch(`${root}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Custom domain ${label}`, email, password: `Custom-${marker}!` }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert(cookie);
  const [created] = await db.select().from(usersTable).where(eq(usersTable.email, email)); assert(created);
  userIds.push(created.id);
  await db.insert(membershipsTable).values({ organizationId, userId: created.id, groupId, status: "active" });
  return { cookie, id: created.id };
}
const request = (path: string, init: RequestInit = {}, cookie?: string) => fetch(`${root}${path}`, {
  ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
});
const postDomain = (hostname: string, cookie?: string) => request("/api/custom-domain", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname }),
}, cookie);
const verify = (cookie?: string) => request("/api/custom-domain/verify", { method: "POST" }, cookie);
const resolver = (resolveTxt: DomainDnsResolver["resolveTxt"]): DomainDnsResolver => ({ resolveTxt });

try {
  setCustomDomainVerificationEnqueuerForTest(async (id) => { queued.push(id); return id; });
  await db.insert(plansTable).values([
    { id: planYes, code: `domain-yes-${marker}`, name: "Domain", storageLimitGb: 1, entitlements: { "branding.custom_domain": true } },
    { id: planNo, code: `domain-no-${marker}`, name: "No domain", storageLimitGb: 1, entitlements: {} },
  ]);
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Domain A", slug: `domain-a-${marker}`, planId: planYes, status: "active" },
    { id: orgB, name: "Domain B", slug: `domain-b-${marker}`, planId: planYes, status: "active" },
    { id: orgNo, name: "Domain No", slug: `domain-no-${marker}`, planId: planNo, status: "active" },
  ]);
  await db.insert(organizationCustomizationTable).values([{ organizationId: orgA }, { organizationId: orgB }, { organizationId: orgNo }]);
  await db.insert(permissionGroupsTable).values([
    { id: managerGroup, organizationId: orgA, name: "Managers", description: "smoke" },
    { id: memberGroup, organizationId: orgA, name: "Members", description: "smoke" },
    { id: managerBGroup, organizationId: orgB, name: "Managers", description: "smoke" },
    { id: managerNoGroup, organizationId: orgNo, name: "Managers", description: "smoke" },
  ]);
  await db.insert(permissionsTable).values({ key: "workspace.manage", description: "workspace" }).onConflictDoNothing();
  await db.insert(groupPermissionsTable).values([
    { groupId: managerGroup, permissionKey: "workspace.manage" },
    { groupId: managerBGroup, permissionKey: "workspace.manage" },
    { groupId: managerNoGroup, permissionKey: "workspace.manage" },
  ]);
  const manager = await user("manager", orgA, managerGroup);
  const member = await user("member", orgA, memberGroup);
  const managerB = await user("manager-b", orgB, managerBGroup);
  const managerNo = await user("manager-no", orgNo, managerNoGroup);
  await db.update(organizationCustomizationTable).set({
    logoObjectKey: `branding-internal/${orgA}/logo`,
    watermarkObjectKey: `branding-internal/${orgA}/watermark`,
  }).where(eq(organizationCustomizationTable.organizationId, orgA));
  const workspaceResponse = await request("/api/workspace", {}, manager.cookie);
  assert.equal(workspaceResponse.status, 200);
  const workspaceBody = await workspaceResponse.json() as Record<string, unknown>;
  assert.equal(workspaceBody.hasLogoAsset, true);
  assert.equal(workspaceBody.hasWatermarkAsset, true);
  assert(!("logoObjectKey" in workspaceBody));
  assert(!("watermarkObjectKey" in workspaceBody), "internal branding object keys are not API capabilities");

  for (const path of ["/api/custom-domain", "/api/custom-domain/verify"]) {
    assert.equal((await request(path, { method: path.endsWith("verify") ? "POST" : "GET" })).status, 401);
  }
  assert.equal((await request("/api/custom-domain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await request("/api/custom-domain", { method: "DELETE" })).status, 401);
  assert.equal((await request("/api/custom-domain", {}, member.cookie)).status, 403);
  assert.equal((await postDomain("member.customer-host.net", member.cookie)).status, 403);
  assert.equal((await postDomain("no-plan.customer-host.net", managerNo.cookie)).status, 403);
  const [downgradedDomain] = await db.insert(customDomainsTable).values({
    organizationId: orgNo,
    hostname: "retained.customer-host.net",
    challengeName: "_video-verify.retained.customer-host.net",
    challengeValue: "video-domain-verify=must-not-leak",
  }).returning();
  await db.update(organizationCustomizationTable).set({
    customDomain: downgradedDomain!.hostname,
    customDomainVerified: false,
  }).where(eq(organizationCustomizationTable.organizationId, orgNo));
  const downgradedStatus = await request("/api/custom-domain", {}, managerNo.cookie);
  assert.equal(downgradedStatus.status, 200);
  const downgradedBody = await downgradedStatus.json() as { hostname: string; txtRecordName: string | null; txtRecordValue: string | null };
  assert.equal(downgradedBody.hostname, downgradedDomain!.hostname);
  assert.equal(downgradedBody.txtRecordName, null);
  assert.equal(downgradedBody.txtRecordValue, null, "plan downgrade redacts ownership challenges");
  assert.equal((await verify(managerNo.cookie)).status, 403);
  assert.equal((await request("/api/custom-domain", { method: "DELETE" }, managerNo.cookie)).status, 204, "downgraded workspaces retain cleanup access");

  for (const hostile of ["example.com", "127.0.0.1", "localhost", "foo.internal", "foo.intranet", "foo.corp", "foo.home.arpa", "https://x.com", "x.com:443", "*.x.com", "bad..x.com", "-bad.x.com", "bad-.x.com", "bad\u0000.x.com"]) {
    assert.equal((await postDomain(hostile, manager.cookie)).status, 400, hostile);
  }
  assert.equal(normalizeHostname("BÜCHER.customer-host.net."), "xn--bcher-kva.customer-host.net");
  const first = await postDomain("BÜCHER.customer-host.net.", manager.cookie);
  assert.equal(first.status, 202);
  const firstBody = await first.json() as { hostname: string; txtRecordName: string; txtRecordValue: string };
  assert.equal(firstBody.hostname, "xn--bcher-kva.customer-host.net");
  assert.equal(firstBody.txtRecordName, "_video-verify.xn--bcher-kva.customer-host.net");
  assert(firstBody.txtRecordValue.startsWith("video-domain-verify="));
  assert.equal((await postDomain("xn--bcher-kva.customer-host.net", manager.cookie)).status, 202, "same host is idempotent");
  assert.equal((await request("/api/custom-domain", {}, manager.cookie)).status, 200);
  assert.equal((await postDomain("replacement.customer-host.net", manager.cookie)).status, 202);
  const aRows = await db.select().from(customDomainsTable).where(eq(customDomainsTable.organizationId, orgA));
  assert.equal(aRows.length, 2); assert(aRows.some((row) => row.lifecycleState === "removed" && row.hostname === "xn--bcher-kva.customer-host.net"));
  const historicalReplacement = aRows.find((row) => row.lifecycleState !== "removed")!; assert(historicalReplacement);

  assert.equal((await postDomain("replacement.customer-host.net", managerB.cookie)).status, 409);
  assert.equal((await request("/api/custom-domain", { method: "DELETE" }, manager.cookie)).status, 204);
  assert.equal((await verify(manager.cookie)).status, 409, "missing domains do not consume verification budget");
  const [missingDomainWindow] = await db.select().from(customDomainVerificationWindowsTable)
    .where(eq(customDomainVerificationWindowsTable.organizationId, orgA));
  assert.equal(missingDomainWindow, undefined);
  assert.equal((await postDomain("replacement.customer-host.net", managerB.cookie)).status, 202);

  // The request only persists/enqueues: injected DNS is never called by HTTP.
  let resolverCalls = 0;
  const bCurrent = (await db.select().from(customDomainsTable).where(and(eq(customDomainsTable.organizationId, orgB), eq(customDomainsTable.lifecycleState, "pending_verification"))))[0]!;
  assert.equal((await verify(managerB.cookie)).status, 202);
  assert.equal(resolverCalls, 0); assert.deepEqual(queued, [bCurrent.id]);
  const perRow = await verify(managerB.cookie); assert.equal(perRow.status, 429); assert.equal(perRow.headers.get("retry-after"), "60");
  const liveDispatchClaim = randomUUID();
  await db.update(customDomainsTable).set({
    lifecycleState: "verifying",
    claimToken: liveDispatchClaim,
    claimedAt: new Date(Date.now() - 61_000),
    verifyRequestedAt: new Date(Date.now() - 61_000),
    retryAfterAt: new Date(0),
  }).where(eq(customDomainsTable.id, bCurrent.id));
  const delayedWorkerRetry = await verify(managerB.cookie);
  assert.equal(delayedWorkerRetry.status, 429);
  const [stillClaimed] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, bCurrent.id));
  assert.equal(stillClaimed?.lifecycleState, "verifying");
  assert.equal(stillClaimed?.claimToken, liveDispatchClaim, "requests cannot steal an in-flight worker claim");
  await db.update(customDomainsTable).set({
    lifecycleState: "pending_verification",
    claimToken: null,
    claimedAt: null,
    verifyRequestedAt: new Date(Date.now() - 61_000),
  }).where(eq(customDomainsTable.id, bCurrent.id));
  for (let i = 0; i < 5; i++) {
    const response = await verify(managerB.cookie);
    if (i < 4) { assert.equal(response.status, 202); await db.update(customDomainsTable).set({ verifyRequestedAt: new Date(Date.now() - 61_000) }).where(eq(customDomainsTable.id, bCurrent.id)); }
    else { assert.equal(response.status, 429); assert(response.headers.get("retry-after")); }
  }

  // Worker result is exact-TXT only, and the conditional claim makes concurrent calls single-flight.
  await db.update(customDomainVerificationWindowsTable).set({ attempts: 1, windowStartedAt: new Date(Date.now() - 16 * 60_000) }).where(eq(customDomainVerificationWindowsTable.organizationId, orgB));
  const exact = resolver(async (name) => {
    resolverCalls++;
    assert.equal(name, bCurrent.challengeName);
    return [[bCurrent.challengeValue], ["wrong"]];
  });
  await assert.rejects(() => processCustomDomainVerification(bCurrent.id, exact, async () => {
    throw new Error("forced audit transaction rollback");
  }));
  const [rolledBack] = await db.select().from(organizationCustomizationTable).where(eq(organizationCustomizationTable.organizationId, orgB));
  assert.equal(rolledBack?.customDomainVerified, false, "verification and customization commit atomically with audit");
  await db.update(customDomainsTable).set({ lifecycleState: "pending_verification", claimToken: null, claimedAt: null }).where(eq(customDomainsTable.id, bCurrent.id));
  const callsBeforeConcurrent = resolverCalls;
  const both = await Promise.all([processCustomDomainVerification(bCurrent.id, exact), processCustomDomainVerification(bCurrent.id, exact)]);
  assert.equal(both.filter((result) => "verified" in result && result.verified).length, 1);
  assert.equal(resolverCalls, callsBeforeConcurrent + 1, "claim permits only one TXT lookup");
  const [verified] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, bCurrent.id));
  assert.equal(verified?.lifecycleState, "verified");
  const [customization] = await db.select().from(organizationCustomizationTable).where(eq(organizationCustomizationTable.organizationId, orgB));
  assert.equal(customization?.customDomainVerified, true);
  const verifiedStatus = await request("/api/custom-domain", {}, managerB.cookie);
  const verifiedBody = await verifiedStatus.json() as { txtRecordName: string | null; txtRecordValue: string | null };
  assert.equal(verifiedBody.txtRecordName, null);
  assert.equal(verifiedBody.txtRecordValue, null, "verified challenges are never returned");
  const verifiedAudits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgB), eq(auditLogsTable.action, "custom_domain.verified")));
  assert.equal(verifiedAudits.length, 1); assert.equal(verifiedAudits[0]!.category, "workspace");
  assert(!JSON.stringify(verifiedAudits[0]).includes(bCurrent.challengeValue));

  // A stale verification claim cannot overwrite a newer customization binding.
  assert.equal((await postDomain("stale.customer-host.net", manager.cookie)).status, 202);
  const [staleDomain] = await db.select().from(customDomainsTable).where(and(
    eq(customDomainsTable.organizationId, orgA),
    eq(customDomainsTable.lifecycleState, "pending_verification"),
  ));
  assert(staleDomain);
  await db.update(organizationCustomizationTable).set({
    customDomain: "newer.customer-host.net",
    customDomainVerified: false,
  }).where(eq(organizationCustomizationTable.organizationId, orgA));
  const staleResult = await processCustomDomainVerification(
    staleDomain.id,
    resolver(async () => [[staleDomain.challengeValue]]),
  );
  assert("verified" in staleResult);
  assert.equal(staleResult.verified, false);
  const [staleRejected] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, staleDomain.id));
  assert.equal(staleRejected?.lifecycleState, "reconciliation_required");
  assert.equal(staleRejected?.diagnosticCode, "stale_domain_binding");
  assert.equal((await request("/api/custom-domain", { method: "DELETE" }, manager.cookie)).status, 204);

  // Failure is retryable until capped; only the initial failure and terminal suspension audit.
  assert.equal((await postDomain("failure.customer-host.net", manager.cookie)).status, 202);
  const [failureDomain] = await db.select().from(customDomainsTable).where(and(
    eq(customDomainsTable.organizationId, orgA),
    inArray(customDomainsTable.lifecycleState, ["pending_verification", "verifying", "verified", "failed", "suspended", "reconciliation_required"]),
  ));
  assert(failureDomain, "failure fixture must use the current active claim, never retained history");
  await db.update(customDomainsTable).set({ lifecycleState: "pending_verification", attempts: 0, retryable: true, verifyRequestedAt: null }).where(eq(customDomainsTable.id, failureDomain.id));
  const mismatch = resolver(async () => [["video-domain-verify=wrong"]]);
  const dnsError = resolver(async () => { throw new Error("ENOTFOUND"); });
  await processCustomDomainVerification(failureDomain.id, dnsError);
  await db.update(customDomainsTable).set({ verifyRequestedAt: new Date(0) }).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal((await verify(manager.cookie)).status, 429, "worker backoff cannot be bypassed by the request route");
  for (let i = 0; i < 7; i++) {
    await db.update(customDomainsTable).set({
      lifecycleState: "pending_verification",
      retryAfterAt: new Date(0),
    }).where(eq(customDomainsTable.id, failureDomain.id));
    await processCustomDomainVerification(failureDomain.id, mismatch);
  }
  const [suspended] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal(suspended?.lifecycleState, "suspended"); assert.equal(suspended?.retryable, false);
  const failedAudits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.action, "custom_domain.verification_failed")));
  assert.equal(failedAudits.length, 1);
  await db.update(customDomainsTable).set({ lifecycleState: "verifying", claimedAt: new Date(Date.now() - 11 * 60_000), claimToken: randomUUID(), retryable: true }).where(eq(customDomainsTable.id, failureDomain.id));
  const repairJobIds: string[] = [];
  const fakeQueue = {
    send: async (_name: string, _data: unknown, options: { id: string }) => {
      repairJobIds.push(options.id);
      return options.id;
    },
    findJobs: async () => [],
  };
  await repairCustomDomainVerifications(fakeQueue as never);
  let [repaired] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal(repaired?.lifecycleState, "verifying");
  assert(repaired?.claimToken, "queued verification retains durable dispatch ownership");
  await db.update(customDomainsTable).set({
    lifecycleState: "failed",
    claimToken: null,
    claimedAt: null,
    retryAfterAt: new Date(0),
  }).where(eq(customDomainsTable.id, failureDomain.id));
  await repairCustomDomainVerifications(fakeQueue as never);
  assert.equal(repairJobIds.length, 2);
  assert.notEqual(repairJobIds[0], repairJobIds[1], "retained queue rows cannot suppress a later verification");
  [repaired] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal(repaired?.lifecycleState, "verifying"); assert.equal(repaired?.retryable, true);

  // RLS reads are tenant-scoped even when explicitly using the application role.
  const rlsRows = await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql`select set_config('app.organization_id', ${orgA}, true)`);
    return tx.select({ organizationId: customDomainsTable.organizationId }).from(customDomainsTable);
  });
  assert(rlsRows.every((row) => row.organizationId === orgA));
  const forgedWorkerRows = await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql`select set_config('app.organization_id', ${orgA}, true)`);
    await tx.execute(sql`select set_config('app.custom_domain_worker', 'on', true)`);
    return tx.select({ organizationId: customDomainsTable.organizationId }).from(customDomainsTable);
  });
  assert(forgedWorkerRows.every((row) => row.organizationId === orgA), "tenant role cannot opt into worker RLS");
  await db.update(customDomainsTable).set({
    lifecycleState: "pending_verification",
    retryable: true,
    claimToken: null,
    claimedAt: null,
    retryAfterAt: new Date(0),
  }).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal((await request("/api/custom-domain", { method: "DELETE" }, manager.cookie)).status, 204);
  assert.equal((await request("/api/custom-domain", { method: "DELETE" }, manager.cookie)).status, 204);
  const [removed] = await db.select().from(customDomainsTable).where(eq(customDomainsTable.id, failureDomain.id));
  assert.equal(removed?.challengeValue, "revoked");
  const [cleared] = await db.select().from(organizationCustomizationTable).where(eq(organizationCustomizationTable.organizationId, orgA));
  assert.equal(cleared?.customDomain, null);
  console.log("Custom-domain HTTP + DB lifecycle smoke passed");
} finally {
  setCustomDomainVerificationEnqueuerForTest(undefined);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const orgs = [orgA, orgB, orgNo];
  await db.delete(customDomainVerificationWindowsTable).where(inArray(customDomainVerificationWindowsTable.organizationId, orgs));
  await db.delete(auditLogsTable).where(inArray(auditLogsTable.organizationId, orgs));
  await db.delete(customDomainsTable).where(inArray(customDomainsTable.organizationId, orgs));
  await db.delete(membershipsTable).where(inArray(membershipsTable.organizationId, orgs));
  if (userIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, userIds));
    await db.delete(accountsTable).where(inArray(accountsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await db.delete(permissionGroupsTable).where(inArray(permissionGroupsTable.organizationId, orgs));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgs));
  await db.delete(plansTable).where(or(eq(plansTable.id, planYes), eq(plansTable.id, planNo)));
}