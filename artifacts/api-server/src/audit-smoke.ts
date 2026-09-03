import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
if (process.env.NODE_ENV !== "test") throw new Error("audit smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
const { and, eq, or, sql } = await import("drizzle-orm");
const { auditLogsTable, analyticsRateWindowsTable, db, groupPermissionsTable, membershipsTable, organizationsTable, permissionGroupsTable, permissionsTable, plansTable, sessionsTable, usersTable } = await import("@workspace/db");
const { default: app } = await import("./app");
const { AUDIT_JSON_MAX_BYTES, AuditExportRateLimitError, auditDiff, auditJob, auditSystem, auditWebhook, consumeAuditExportLimit, sanitizeAuditValue, writeAuditEvent } = await import("./lib/audit");
const { withOrganizationDb } = await import("./lib/tenant-db");
const { reconcileSystemVideoDeletePermission } = await import("./lib/bootstrap");

const marker = randomUUID(), planId = randomUUID(), orgA = randomUUID(), orgB = randomUUID();
const ownerGroup = randomUUID(), editorGroup = randomUUID(), viewerGroup = randomUUID(), ownerBGroup = randomUUID(), renamedAdminGroup = randomUUID(), regularGroup = randomUUID();
const created = new Date("2025-06-10T12:00:00.000Z");
const ids: string[] = [];
const insert = async (organizationId: string, values: Partial<typeof auditLogsTable.$inferInsert> & { action: string; subjectLabel: string }) => {
  const id = values.id ?? randomUUID(); ids.push(id);
  await db.insert(auditLogsTable).values({ id, organizationId, actorKind: "system", category: "video", subjectType: "video", metadata: {}, createdAt: created, ...values });
  return id;
};
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const address = server.address(); assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;
async function session(label: string, groupId: string, organizationId = orgA) {
  const email = `audit-${label}-${marker}@example.test`;
  const r = await fetch(`${root}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Audit ${label}`, email, password: `Audit-${marker}!` }) });
  assert.equal(r.status, 200); const cookie = r.headers.get("set-cookie")?.split(";")[0]; assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)); assert(user);
  await db.insert(membershipsTable).values({ organizationId, userId: user.id, groupId, status: "active" });
  return { cookie, user };
}
try {
  await db.insert(plansTable).values({ id: planId, code: `audit-${marker}`, name: "Audit", storageLimitGb: 1 });
  await db.insert(organizationsTable).values([{ id: orgA, name: "Audit A", slug: `audit-a-${marker}`, planId, status: "active" }, { id: orgB, name: "Audit B", slug: `audit-b-${marker}`, planId, status: "active" }]);
  await db.insert(permissionGroupsTable).values([
    { id: ownerGroup, organizationId: orgA, name: "Owners", description: "audit" }, { id: editorGroup, organizationId: orgA, name: "Editors", description: "audit" },
    { id: viewerGroup, organizationId: orgA, name: "Viewers", description: "audit" }, { id: ownerBGroup, organizationId: orgB, name: "Owners", description: "audit" },
    { id: renamedAdminGroup, organizationId: orgA, name: "Renamed Operations Council", description: "custom" },
    { id: regularGroup, organizationId: orgA, name: "Regular custom group", description: "custom" },
  ]);
  await db.insert(permissionsTable).values([{ key: "audit.read", description: "read" }, { key: "audit.export", description: "export" }, { key: "workspace.manage", description: "workspace" }, { key: "members.manage", description: "members" }]).onConflictDoNothing();
  await db.insert(groupPermissionsTable).values([{ groupId: ownerGroup, permissionKey: "audit.read" }, { groupId: ownerGroup, permissionKey: "audit.export" }, { groupId: ownerBGroup, permissionKey: "audit.read" }, { groupId: renamedAdminGroup, permissionKey: "workspace.manage" }, { groupId: renamedAdminGroup, permissionKey: "members.manage" }, { groupId: regularGroup, permissionKey: "workspace.manage" }]);
  await reconcileSystemVideoDeletePermission();
  const reconciled = await db.select().from(groupPermissionsTable).where(or(eq(groupPermissionsTable.groupId, renamedAdminGroup), eq(groupPermissionsTable.groupId, regularGroup)));
  assert.deepEqual(reconciled.filter((row) => row.groupId === renamedAdminGroup && row.permissionKey.startsWith("audit.")).map((row) => row.permissionKey).sort(), ["audit.export", "audit.read"]);
  assert.equal(reconciled.some((row) => row.groupId === regularGroup && row.permissionKey.startsWith("audit.")), false);
  const owner = await session("owner", ownerGroup), editor = await session("editor", editorGroup), viewer = await session("viewer", viewerGroup);
  const ownerB = await session("owner-b", ownerBGroup, orgB);
  // Same timestamp makes UUID descending tie-breaking observable.
  for (let i = 0; i < 6; i++) await insert(orgA, { action: `video.updated.${i}`, category: i % 2 ? "video" : "workspace", subjectType: i % 2 ? "video" : "folder", subjectId: `subject-${i}`, subjectLabel: i === 2 ? "Needle, \"quoted\"\nline" : `event-${i}`, actorKind: i === 1 ? "user" : "system", actorUserId: i === 1 ? owner.user.id : null, metadata: i === 2 ? { note: "=formula" } : {} });
  await insert(orgB, { action: "video.foreign", subjectLabel: "foreign" });
  await withOrganizationDb(orgA, async (tx) => {
    await writeAuditEvent(tx, { organizationId: orgA, actor: auditWebhook(), action: "webhook.received", category: "webhook", subject: { type: "webhook", id: "webhook-1", label: "webhook" }, metadata: { token: "secret", nested: { authorization: "secret" } } });
    await writeAuditEvent(tx, { organizationId: orgA, actor: auditJob(), action: "job.completed", category: "operations", subject: { type: "job", id: "job-1", label: "job" } });
    await writeAuditEvent(tx, { organizationId: orgA, actor: auditSystem(), action: "system.created", category: "operations", subject: { type: "system", id: "system-1", label: "system" } });
  });
  // Endpoint fixtures keep their timestamp in the traversed test window.
  await insert(orgA, { action: "webhook.received", category: "webhook", subjectType: "webhook", subjectId: "webhook-1", subjectLabel: "webhook", actorKind: "webhook" });
  await insert(orgA, { action: "job.completed", category: "operations", subjectType: "job", subjectId: "job-1", subjectLabel: "job", actorKind: "job" });
  const dangerous = sanitizeAuditValue({ password: "secret", nested: { authorization: "secret" }, long: "x".repeat(5000), array: Array.from({ length: 101 }, () => "x") });
  assert.equal(dangerous.password, "[redacted]"); assert.equal((dangerous.nested as Record<string, unknown>).authorization, "[redacted]"); assert.equal((dangerous.long as string).length, 4000); assert.equal((dangerous.array as unknown[]).length, 100); assert.deepEqual(Object.keys(auditDiff({}, {})), ["beforeState", "afterState"]);
  const huge = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`長いキー${index}${"界".repeat(100)}`, `${"é".repeat(2100)}-${index}`]));
  await withOrganizationDb(orgA, (tx) => writeAuditEvent(tx, { organizationId: orgA, actor: auditSystem(), action: "sanitizer.boundary", category: "operations", subject: { type: "test", label: "boundary" }, beforeState: huge, afterState: huge, metadata: { ...huge, providerCredential: "must-not-survive" } }));
  const [bounded] = await db.select({ before: auditLogsTable.beforeState, after: auditLogsTable.afterState, metadata: auditLogsTable.metadata }).from(auditLogsTable).where(eq(auditLogsTable.action, "sanitizer.boundary"));
  assert(bounded); assert(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= AUDIT_JSON_MAX_BYTES); assert(!JSON.stringify(bounded).includes("must-not-survive"));
  const get = (path: string, cookie?: string) => fetch(`${root}${path}`, { headers: cookie ? { cookie } : {} });
  assert.equal((await get("/api/audit-events")).status, 401);
  assert.equal((await get("/api/audit-events", editor.cookie)).status, 403); assert.equal((await get("/api/audit-events", viewer.cookie)).status, 403);
  assert.equal((await get("/api/audit-events/export", editor.cookie)).status, 403);
  const first = await get("/api/audit-events?limit=2", owner.cookie); assert.equal(first.status, 200);
  const page1 = await first.json() as { items: Array<{ id: string }>; nextCursor: string; snapshotAt: string }; assert.equal(page1.items.length, 2); assert(page1.nextCursor);
  await insert(orgA, { action: "video.newer", subjectLabel: "newer", createdAt: new Date(Date.now() + 60_000) });
  const second = await get(`/api/audit-events?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, owner.cookie); assert.equal(second.status, 200);
  const page2 = await second.json() as { items: Array<{ id: string }>; nextCursor: string | null }; assert.equal(page2.items.some((x) => x.id === ids.at(-1)), false); assert.equal(new Set([...page1.items, ...page2.items].map((x) => x.id)).size, 4);
  assert.equal((await get(`/api/audit-events?limit=2&cursor=${encodeURIComponent(`${page1.nextCursor}x`)}`, owner.cookie)).status, 400);
  assert.equal((await get(`/api/audit-events?limit=2&category=video&cursor=${encodeURIComponent(page1.nextCursor)}`, owner.cookie)).status, 400);
  assert.equal((await get(`/api/audit-events?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, ownerB.cookie)).status, 400, "org B rejects tenant-bound cursor");
  assert.equal((await get("/api/audit-events?limit=0", owner.cookie)).status, 400); assert.equal((await get("/api/audit-events?cursor=not-a-cursor", owner.cookie)).status, 400);
  const [cursorBody] = page1.nextCursor.split("."); assert(cursorBody);
  const expiredPayload = JSON.parse(Buffer.from(cursorBody, "base64url").toString("utf8")) as { expiresAt: number }; expiredPayload.expiresAt = 0;
  const expiredBody = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const cursorKey = createHmac("sha256", process.env.SESSION_SECRET!).update("video-library-cursor:v1").digest();
  const expiredCursor = `${expiredBody}.${createHmac("sha256", cursorKey).update(`audit:v1.${expiredBody}`).digest("base64url")}`;
  assert.equal((await get(`/api/audit-events?cursor=${encodeURIComponent(expiredCursor)}`, owner.cookie)).status, 400);
  for (const query of ["category=webhook", "action=webhook.received", "subjectType=webhook", "subjectId=webhook-1", "actorKind=webhook", `actorUserId=${owner.user.id}`, "from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z", "search=Needle"]) {
    const r = await get(`/api/audit-events?${query}`, owner.cookie); assert.equal(r.status, 200); const filtered = await r.json() as { items: unknown[] }; assert(filtered.items.length >= 1, `${query}: ${JSON.stringify(filtered)}`);
  }
  const all = await get("/api/audit-events?limit=100", owner.cookie); const actorKinds = new Set((await all.json() as { items: Array<{ actor: { kind: string; userId: string | null } }> }).items.map((x) => x.actor.kind));
  for (const kind of ["user", "system", "job", "webhook"]) assert(actorKinds.has(kind)); assert(actorKinds.has("system"));
  await insert(orgA, { action: "video.exported", category: "video", subjectType: "video", subjectId: "export-1", subjectLabel: "=Needle, \"quoted\"\nline", metadata: { note: "=formula" }, createdAt: new Date() });
  const exported = await get("/api/audit-events/export?search=Needle", owner.cookie); assert.equal(exported.status, 200); assert.match(exported.headers.get("content-type") ?? "", /text\/csv/); assert.match(exported.headers.get("content-disposition") ?? "", /audit-events\.csv/);
  const csv = await exported.text(); assert(csv.includes("\"'=Needle, \"\"quoted\"\"\nline\"")); assert(!csv.includes("secret"));
  assert.equal((await get("/api/audit-events/export?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z", owner.cookie)).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await get("/api/audit-events/export", owner.cookie)).status, 200);
  const limited = await get("/api/audit-events/export", owner.cookie); assert.equal(limited.status, 429); assert(limited.headers.get("retry-after"));
  await assert.rejects(() => withOrganizationDb(orgA, async (tx) => { await writeAuditEvent(tx, { organizationId: orgA, actor: auditSystem(), action: "rollback.test", category: "operations", subject: { type: "test", label: "rollback" } }); throw new Error("rollback"); }));
  await assert.rejects(() => db.transaction(async (tx) => { await tx.execute(sql.raw("set local role vid_app")); await tx.execute(sql`select set_config('app.organization_id', ${orgA}, true)`); await tx.update(auditLogsTable).set({ action: "bad" }).where(eq(auditLogsTable.organizationId, orgA)); }), (e: unknown) => /permission denied/i.test(String((e as { cause?: unknown }).cause ?? e)));
  await assert.rejects(() => db.transaction(async (tx) => { await tx.execute(sql.raw("set local role vid_app")); await tx.execute(sql`select set_config('app.organization_id', ${orgA}, true)`); await tx.delete(auditLogsTable).where(eq(auditLogsTable.organizationId, orgA)); }), (e: unknown) => /permission denied/i.test(String((e as { cause?: unknown }).cause ?? e)));
  console.log("Audit HTTP smoke passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(analyticsRateWindowsTable).where(and(eq(analyticsRateWindowsTable.organizationId, orgA), eq(analyticsRateWindowsTable.dimensionType, "audit_export")));
  await db.delete(auditLogsTable).where(or(eq(auditLogsTable.organizationId, orgA), eq(auditLogsTable.organizationId, orgB)));
  await db.delete(membershipsTable).where(or(eq(membershipsTable.organizationId, orgA), eq(membershipsTable.organizationId, orgB)));
  const smokeUsers = await db.select({ id: usersTable.id }).from(usersTable).where(sql`${usersTable.email} like ${`audit-%-${marker}@example.test`}`);
  if (smokeUsers.length) { await db.delete(sessionsTable).where(sql`${sessionsTable.userId} in (${sql.join(smokeUsers.map((u) => sql`${u.id}`), sql`,`)})`); await db.delete(usersTable).where(sql`${usersTable.id} in (${sql.join(smokeUsers.map((u) => sql`${u.id}`), sql`,`)})`); }
  await db.delete(permissionGroupsTable).where(or(eq(permissionGroupsTable.organizationId, orgA), eq(permissionGroupsTable.organizationId, orgB)));
  await db.delete(organizationsTable).where(eq(organizationsTable.planId, planId)); await db.delete(plansTable).where(eq(plansTable.id, planId));
}