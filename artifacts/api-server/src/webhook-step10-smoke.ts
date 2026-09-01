import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "test") throw new Error("Step 10 smoke requires NODE_ENV=test");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
process.env.JOB_QUEUE_NAMESPACE = `step10-${process.pid}`;

const {
  db,
  pool,
  organizationsTable,
  organizationCustomizationTable,
  plansTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
  webhookEventsTable,
  embedGenerationOutboxTable,
} = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { createStep10BunnyCallback } = await import("@workspace/providers/test-only");
const { encryptProviderCredentials } = await import("./lib/credential-encryption");
const { default: app } = await import("./app");
const {
  EMBED_GENERATION_QUEUE,
  startJobs,
  stopJobs,
  dispatchPendingEmbedOutbox,
} = await import("./lib/jobs");

const marker = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const accountId = randomUUID();
const otherAccountId = randomUUID();
const libraryId = 910_000_000 + Math.floor(Math.random() * 10_000_000);
const otherLibraryId = libraryId + 1;
const readOnlyApiKey = `step10-read-${marker}`;
const accountEnvelope = encryptProviderCredentials({ accountApiKey: `step10-account-${marker}` });
const libraryEnvelope = encryptProviderCredentials({
  apiKey: `step10-library-${marker}`,
  readOnlyApiKey,
  zoneSecurityKey: `step10-zone-${marker}`,
});
const ids = {
  ready: randomUUID(),
  error: randomUUID(),
  invalid: randomUUID(),
  duplicate: randomUUID(),
  terminalReady: randomUUID(),
  terminalError: randomUUID(),
  mismatch: randomUUID(),
};
const assets = Object.fromEntries(Object.keys(ids).map((key) => [key, `${marker}-${key}`])) as Record<keyof typeof ids, string>;

await db.transaction(async (tx) => {
  await tx.insert(plansTable).values({
    id: planId, code: `step10-${marker}`, name: "Step 10 smoke", storageLimitGb: 1,
  });
  await tx.insert(organizationsTable).values([
    { id: organizationId, name: "Step 10 smoke", slug: `step10-${marker}`, status: "active", planId },
    { id: otherOrganizationId, name: "Step 10 mismatch", slug: `step10-other-${marker}`, status: "active", planId },
  ]);
  await tx.insert(organizationCustomizationTable).values([
    { organizationId },
    { organizationId: otherOrganizationId },
  ]);
  await tx.insert(providerAccountsTable).values([
    {
      id: accountId, providerKey: "bunny", label: `step10-${marker}`,
      encryptedCredentials: accountEnvelope, maxZones: 10,
    },
    {
      id: otherAccountId, providerKey: "bunny", label: `step10-other-${marker}`,
      encryptedCredentials: accountEnvelope, maxZones: 10,
    },
  ]);
  await tx.insert(providerTenantSpacesTable).values([
    {
      organizationId, providerAccountId: accountId, providerSpaceId: String(libraryId),
      idempotencyKey: `step10-${marker}`, encryptedCredentials: libraryEnvelope,
      metadata: { pullZoneId: "1", pullZoneHostname: "step10.invalid", zoneSecurityEnabled: true },
      state: "created",
    },
    {
      organizationId: otherOrganizationId, providerAccountId: otherAccountId,
      providerSpaceId: String(otherLibraryId), idempotencyKey: `step10-other-${marker}`,
      encryptedCredentials: libraryEnvelope,
      metadata: { pullZoneId: "2", pullZoneHostname: "step10-other.invalid", zoneSecurityEnabled: true },
      state: "created",
    },
  ]);
  await tx.insert(videosTable).values([
    video(ids.ready, assets.ready, "processing", accountId, String(libraryId), organizationId, "public"),
    video(ids.error, assets.error, "processing", accountId, String(libraryId), organizationId),
    video(ids.invalid, assets.invalid, "processing", accountId, String(libraryId), organizationId),
    video(ids.duplicate, assets.duplicate, "processing", accountId, String(libraryId), organizationId),
    video(ids.terminalReady, assets.terminalReady, "ready", accountId, String(libraryId), organizationId),
    video(ids.terminalError, assets.terminalError, "error", accountId, String(libraryId), organizationId),
    // Deliberately combines another account with the callback's tenant-space string.
    video(ids.mismatch, assets.mismatch, "processing", otherAccountId, String(libraryId), otherOrganizationId),
  ]);
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
assert(address && typeof address === "object");
const root = `http://127.0.0.1:${address.port}`;
let boss: Awaited<ReturnType<typeof startJobs>> | undefined;

try {
  boss = await startJobs();
  assert.equal((await deliver("ready", 3, { durationSeconds: 42 })).status, 202);
  assert.deepEqual(await state(ids.ready), { status: "ready", durationSeconds: 42 });

  assert.equal((await deliver("error", 5)).status, 202);
  assert.equal((await state(ids.error)).status, "error");

  const invalid = createStep10BunnyCallback({
    libraryId, assetId: assets.invalid, status: 3, readOnlyApiKey,
  });
  invalid.headers["x-bunnystream-signature"] = "0".repeat(64);
  assert.equal((await post(invalid.rawBody, invalid.headers)).status, 401);
  assert.equal((await state(ids.invalid)).status, "processing");

  assert.equal((await post(Buffer.from("{"), { "content-type": "application/json" })).status, 400);

  const duplicate = createStep10BunnyCallback({
    libraryId, assetId: assets.duplicate, status: 3, readOnlyApiKey, durationSeconds: 7,
  });
  const duplicateResponses = await Promise.all([
    post(duplicate.rawBody, duplicate.headers),
    post(duplicate.rawBody, duplicate.headers),
  ]);
  assert.deepEqual(duplicateResponses.map((response) => response.status), [202, 202]);
  assert.equal(await receiptCount(assets.duplicate), 1);
  assert.equal(await outboxCount(assets.duplicate), 1);
  assert.deepEqual(await state(ids.duplicate), { status: "ready", durationSeconds: 7 });

  const unknownAsset = `${marker}-unknown`;
  const unknown = createStep10BunnyCallback({
    libraryId, assetId: unknownAsset, status: 3, readOnlyApiKey,
  });
  assert.equal((await post(unknown.rawBody, unknown.headers)).status, 202);
  const [unknownReceipt] = await db.select({
    processingState: webhookEventsTable.processingState,
    diagnosticCode: webhookEventsTable.diagnosticCode,
  }).from(webhookEventsTable).where(eq(webhookEventsTable.providerAssetId, unknownAsset));
  assert.deepEqual(unknownReceipt, { processingState: "ignored", diagnosticCode: "unknown_asset" });

  assert.equal((await deliver("terminalReady", 5)).status, 202);
  assert.equal((await state(ids.terminalReady)).status, "ready");
  assert.equal((await deliver("terminalError", 3)).status, 202);
  assert.equal((await state(ids.terminalError)).status, "error");

  assert.equal((await deliver("mismatch", 3)).status, 202);
  assert.equal((await state(ids.mismatch)).status, "processing");

  const publicResponse = await fetch(`${root}/api/public/videos/${ids.ready}`);
  assert.equal(publicResponse.status, 200);
  const publicText = await publicResponse.text();
  assert.equal(publicText.includes(String(libraryId)), false);
  assert.equal(publicText.includes(assets.ready), false);
  assert.equal(publicText.includes(accountId), false);

  const embedJobs = await boss.findJobs<{ videoId: string }>(EMBED_GENERATION_QUEUE, {});
  assert.equal(embedJobs.filter((job) => job.data.videoId === ids.duplicate).length <= 1, true);
  assert.equal(embedJobs.every((job) => Object.keys(job.data).length === 1 && typeof job.data.videoId === "string"), true);

  // Exercise the decisive crash window: the deterministic embed job has
  // already left "created", but the outbox mark is lost.
  const [readyOutbox] = await db.select({ id: embedGenerationOutboxTable.id })
    .from(embedGenerationOutboxTable)
    .innerJoin(webhookEventsTable, eq(webhookEventsTable.id, embedGenerationOutboxTable.webhookEventId))
    .where(eq(webhookEventsTable.providerAssetId, assets.ready));
  assert(readyOutbox);
  const processed = new Promise<void>((resolve) => {
    void boss!.work<{ videoId: string }>(
      EMBED_GENERATION_QUEUE,
      { batchSize: 1 },
      async ([job]) => {
        if (job.id === readyOutbox.id) resolve();
        return { testOnlyCompleted: true };
      },
    );
  });
  await withTimeout(processed, 10_000, "Timed out activating deterministic embed job");
  await waitForJobState(readyOutbox.id, "completed");
  await boss.offWork(EMBED_GENERATION_QUEUE);

  await db.update(embedGenerationOutboxTable).set({
    state: "dispatching",
    dispatchClaim: randomUUID(),
    claimedAt: new Date(Date.now() - 10 * 60_000),
    dispatchedAt: null,
  }).where(eq(embedGenerationOutboxTable.id, readyOutbox.id));
  await dispatchPendingEmbedOutbox(boss);
  const [repaired] = await db.select({
    state: embedGenerationOutboxTable.state,
    dispatchedAt: embedGenerationOutboxTable.dispatchedAt,
  }).from(embedGenerationOutboxTable).where(eq(embedGenerationOutboxTable.id, readyOutbox.id));
  assert.equal(repaired?.state, "dispatched");
  assert(repaired?.dispatchedAt);
  const exactJobs = await boss.findJobs<{ videoId: string }>(
    EMBED_GENERATION_QUEUE,
    { id: readyOutbox.id },
  );
  assert.equal(exactJobs.length, 1);
  assert.equal(exactJobs[0]?.id, readyOutbox.id);
  assert.equal(exactJobs[0]?.state, "completed");
  const jobsAfterRepair = await boss.findJobs<{ videoId: string }>(EMBED_GENERATION_QUEUE, {});
  assert.equal(jobsAfterRepair.filter((job) => job.data.videoId === ids.ready).length, 1);

  // Beyond the conservative repair horizon, absence of the retained job is
  // ambiguous. Escalate for reconciliation rather than creating a replacement.
  const [longOutageOutbox] = await db.select({ id: embedGenerationOutboxTable.id })
    .from(embedGenerationOutboxTable)
    .innerJoin(webhookEventsTable, eq(webhookEventsTable.id, embedGenerationOutboxTable.webhookEventId))
    .where(eq(webhookEventsTable.providerAssetId, assets.duplicate));
  assert(longOutageOutbox);
  await db.update(embedGenerationOutboxTable).set({
    state: "pending",
    dispatchClaim: null,
    dispatchedAt: null,
  }).where(eq(embedGenerationOutboxTable.id, longOutageOutbox.id));
  await dispatchPendingEmbedOutbox(boss);
  const dispatchedLongOutageJob = await boss.findJobs(
    EMBED_GENERATION_QUEUE,
    { id: longOutageOutbox.id },
  );
  assert.equal(dispatchedLongOutageJob.length, 1);
  await boss.deleteJob(EMBED_GENERATION_QUEUE, longOutageOutbox.id);
  assert.equal((await boss.findJobs(EMBED_GENERATION_QUEUE, { id: longOutageOutbox.id })).length, 0);

  await db.update(embedGenerationOutboxTable).set({
    state: "dispatching",
    dispatchClaim: randomUUID(),
    claimedAt: new Date(Date.now() - 24 * 60 * 60_000),
    dispatchedAt: null,
  }).where(eq(embedGenerationOutboxTable.id, longOutageOutbox.id));
  await dispatchPendingEmbedOutbox(boss);
  const [longOutageReconciliation] = await db.select({
    state: embedGenerationOutboxTable.state,
    diagnosticCode: embedGenerationOutboxTable.diagnosticCode,
  }).from(embedGenerationOutboxTable).where(eq(embedGenerationOutboxTable.id, longOutageOutbox.id));
  assert.deepEqual(longOutageReconciliation, {
    state: "reconciliation_required",
    diagnosticCode: "dispatch_outcome_unknown_after_retention_horizon",
  });
  assert.equal((await boss.findJobs(
    EMBED_GENERATION_QUEUE,
    { id: longOutageOutbox.id },
  )).length, 0);

  console.log("Step 10 webhook smoke passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (boss) {
    const suffix = process.env.JOB_QUEUE_NAMESPACE;
    const queues = [
      `vid.system.health.${suffix}`,
      `vid.provider.bunny-roundtrip.${suffix}`,
      `vid.tenant.provision.${suffix}`,
      `vid.upload.expiry-cleanup.${suffix}`,
      `vid.video.embed-generation.${suffix}`,
      `vid.video.embed-dispatch.${suffix}`,
      `vid.system.dead-letter.${suffix}`,
    ];
    await boss.unschedule(`vid.upload.expiry-cleanup.${suffix}`);
    for (const queue of queues) {
      await boss.offWork(queue);
      await boss.deleteQueuedJobs(queue);
    }
    for (const queue of queues) await boss.deleteQueue(queue);
    await stopJobs();
  }
  await db.delete(webhookEventsTable).where(eq(webhookEventsTable.providerAccountId, accountId));
  await db.delete(videosTable).where(and(
    eq(videosTable.organizationId, otherOrganizationId),
  ));
  await db.delete(videosTable).where(eq(videosTable.organizationId, organizationId));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.providerAccountId, accountId));
  await db.delete(providerTenantSpacesTable).where(eq(providerTenantSpacesTable.providerAccountId, otherAccountId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId));
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, otherAccountId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  await pool.end();
}

function video(
  id: string,
  providerAssetId: string,
  status: "processing" | "ready" | "error",
  providerAccountId: string,
  providerTenantSpaceId: string,
  organizationId: string,
  visibility: "private" | "public" = "private",
) {
  return {
    id, organizationId, title: `Step 10 ${id}`, status, visibility,
    providerAccountId, providerTenantSpaceId, providerAssetId,
  };
}

async function deliver(asset: keyof typeof ids, status: 3 | 5 | 8, extra: { durationSeconds?: number } = {}) {
  const callback = createStep10BunnyCallback({
    libraryId, assetId: assets[asset], status, readOnlyApiKey, ...extra,
  });
  return post(callback.rawBody, callback.headers);
}

function post(body: Buffer, headers: Record<string, string>) {
  return fetch(`${root}/api/webhooks/bunny/encode`, { method: "POST", headers, body });
}

async function state(id: string) {
  const [row] = await db.select({
    status: videosTable.status,
    durationSeconds: videosTable.durationSeconds,
  }).from(videosTable).where(eq(videosTable.id, id));
  assert(row);
  return row;
}

async function receiptCount(providerAssetId: string) {
  const rows = await db.select({ id: webhookEventsTable.id }).from(webhookEventsTable)
    .where(eq(webhookEventsTable.providerAssetId, providerAssetId));
  return rows.length;
}

async function outboxCount(providerAssetId: string) {
  const rows = await db.select({ id: embedGenerationOutboxTable.id })
    .from(embedGenerationOutboxTable)
    .innerJoin(webhookEventsTable, eq(webhookEventsTable.id, embedGenerationOutboxTable.webhookEventId))
    .where(eq(webhookEventsTable.providerAssetId, providerAssetId));
  return rows.length;
}

async function waitForJobState(id: string, expected: string) {
  await withTimeout((async () => {
    while (true) {
      const [job] = await boss!.findJobs(EMBED_GENERATION_QUEUE, { id });
      if (job?.state === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })(), 10_000, `Timed out waiting for embed job ${id} to become ${expected}`);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}