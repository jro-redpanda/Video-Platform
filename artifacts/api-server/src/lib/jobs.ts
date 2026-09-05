import { PgBoss, events, type Job } from "pg-boss";
import { logger } from "./logger";
import { runBunnyRoundTrip } from "./bunny-roundtrip";
import { ProvisioningUnavailableError, provisionTenantOrganization } from "./tenant-provisioning";
import { resolveProvisioningProvider, type ProvisioningProviderResolver } from "./provider-registry";
import { cleanupExpiredUploads } from "./upload-expiry-cleanup";
import { generateVideoEmbed } from "./video-embeds";
import { cleanupThumbnailObjects } from "./thumbnail-cleanup";
import { reconcileActiveBilling } from "./billing-reconciliation";
import { reconcilePendingBillingReceipts } from "./stripe-webhook";
import type { ThumbnailStorage } from "./thumbnail-storage";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  embedGenerationOutboxTable,
  onboardingProvisioningIntentsTable,
  organizationsTable,
  providerTenantSpacesTable,
  videosTable,
} from "@workspace/db";
import { auditJob, writeAuditEvent } from "./audit";
import { randomUUID } from "node:crypto";
import { processAnalyticsDirtyDays, purgeAnalyticsData } from "./analytics-rollup";
import { processCustomDomainVerification } from "./custom-domain";
import { nodeDomainDnsResolver, type DomainDnsResolver } from "./domain-dns-resolver";
import { customDomainsTable } from "@workspace/db";
import { dispatchMasterStorageOperations, processMasterStorageOperation } from "./master-storage-operations";
import { withWorkerDb } from "./worker-db";

const queueSuffix = process.env.JOB_QUEUE_NAMESPACE ? `.${process.env.JOB_QUEUE_NAMESPACE}` : "";
const QUEUE_NAME = `vid.system.health${queueSuffix}`;
const DEAD_LETTER_QUEUE = `vid.system.dead-letter${queueSuffix}`;
export const BUNNY_ROUNDTRIP_QUEUE = `vid.provider.bunny-roundtrip${queueSuffix}`;
export const TENANT_PROVISION_QUEUE = `vid.tenant.provision${queueSuffix}`;
export const ONBOARDING_DISPATCH_QUEUE = `vid.tenant.onboarding-dispatch${queueSuffix}`;
export const UPLOAD_EXPIRY_QUEUE = `vid.upload.expiry-cleanup${queueSuffix}`;
export const EMBED_GENERATION_QUEUE = `vid.video.embed-generation${queueSuffix}`;
export const EMBED_DISPATCH_QUEUE = `vid.video.embed-dispatch${queueSuffix}`;
export const THUMBNAIL_CLEANUP_QUEUE = `vid.thumbnail.cleanup${queueSuffix}`;
export const BILLING_RECONCILIATION_QUEUE = `vid.billing.reconcile${queueSuffix}`;
export const ANALYTICS_ROLLUP_QUEUE = `vid.analytics.rollup${queueSuffix}`;
export const ANALYTICS_RETENTION_QUEUE = `vid.analytics.retention${queueSuffix}`;
export const CUSTOM_DOMAIN_VERIFY_QUEUE = `vid.custom-domain.verify${queueSuffix}`;
export const CUSTOM_DOMAIN_REPAIR_QUEUE = `vid.custom-domain.repair${queueSuffix}`;
export const MASTER_STORAGE_OPERATION_QUEUE = `vid.master-storage.operation${queueSuffix}`;
export const MASTER_STORAGE_DISPATCH_QUEUE = `vid.master-storage.dispatch${queueSuffix}`;

type HealthJob = {
  requestedAt: string;
};

type BunnyRoundTripJob = {
  requestedAt: string;
};
type TenantProvisionJob = { organizationId: string };
type CustomDomainVerificationJob = { domainId: string; dispatchClaim: string };

let boss: PgBoss | undefined;
let bossStart: Promise<PgBoss> | undefined;
let customDomainVerificationEnqueuer: ((domainId: string) => Promise<string | undefined>) | undefined;
let embedDispatchWakeupForTest: (() => Promise<void>) | undefined;

/** Test seam for route lifecycle smokes; production always uses the durable queue. */
export function setCustomDomainVerificationEnqueuerForTest(
  enqueuer?: (domainId: string) => Promise<string | undefined>,
) {
  if (process.env.NODE_ENV !== "test") throw new Error("Custom-domain queue seam is test-only");
  customDomainVerificationEnqueuer = enqueuer;
}

export function setEmbedDispatchWakeupForTest(wakeup?: () => Promise<void>) {
  if (process.env.NODE_ENV !== "test") throw new Error("Embed dispatch wake-up seam is test-only");
  embedDispatchWakeupForTest = wakeup;
}

export async function startJobs(options: {
  resolveProvisioningProvider?: ProvisioningProviderResolver;
  thumbnailStorage?: ThumbnailStorage;
  domainDnsResolver?: DomainDnsResolver;
  bossFactory?: (connectionString: string) => PgBoss;
} = {}) {
  if (boss) return boss;
  if (bossStart) return bossStart;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the job queue");
  if (options.bossFactory && process.env.NODE_ENV !== "test") {
    throw new Error("Job queue factory override is test-only");
  }

  bossStart = (async () => {
    const instance = options.bossFactory?.(connectionString) ?? new PgBoss({
      connectionString,
      schema: "vid_jobs",
      migrate: false,
      application_name: "vid-api-worker",
    });
    instance.on(events.error, () => logger.error({}, "Job queue error"));

    try {
      await instance.start();
      await instance.createQueue(DEAD_LETTER_QUEUE);
  await instance.createQueue(QUEUE_NAME, {
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 30,
    retentionSeconds: 3600,
  });
  await instance.createQueue(BUNNY_ROUNDTRIP_QUEUE, {
    retryLimit: 0,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 1200,
    retentionSeconds: 86400,
  });
  await instance.createQueue(TENANT_PROVISION_QUEUE, {
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 1200,
    retentionSeconds: 86400,
  });
  await instance.createQueue(ONBOARDING_DISPATCH_QUEUE, {
    retryLimit: 0,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 300,
    retentionSeconds: 86400,
  });
  await instance.createQueue(UPLOAD_EXPIRY_QUEUE, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 600,
    retentionSeconds: 86400,
  });
  await instance.createQueue(EMBED_GENERATION_QUEUE, {
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 600,
    retentionSeconds: 86400,
  });
  await instance.createQueue(EMBED_DISPATCH_QUEUE, {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 600,
    retentionSeconds: 86400,
  });
  await instance.createQueue(THUMBNAIL_CLEANUP_QUEUE, {
    // The durable outbox exclusively owns object-level retries/backoff.
    // This periodic wake-up is never itself retried.
    retryLimit: 0,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 600,
    retentionSeconds: 86400,
  });
  await instance.createQueue(BILLING_RECONCILIATION_QUEUE, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 900,
    retentionSeconds: 86400,
  });
  await instance.createQueue(ANALYTICS_ROLLUP_QUEUE, {
    retryLimit: 5, retryDelay: 10, retryBackoff: true, deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 900, retentionSeconds: 86400,
  });
  await instance.createQueue(ANALYTICS_RETENTION_QUEUE, {
    retryLimit: 3, retryDelay: 60, retryBackoff: true, deadLetter: DEAD_LETTER_QUEUE,
    expireInSeconds: 900, retentionSeconds: 86400,
  });
  await instance.createQueue(CUSTOM_DOMAIN_VERIFY_QUEUE, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE, expireInSeconds: 60, retentionSeconds: 86400 });
  await instance.createQueue(CUSTOM_DOMAIN_REPAIR_QUEUE, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE, expireInSeconds: 120, retentionSeconds: 86400 });
  await instance.createQueue(MASTER_STORAGE_OPERATION_QUEUE, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE, expireInSeconds: 1800, retentionSeconds: 86400 });
  await instance.createQueue(MASTER_STORAGE_DISPATCH_QUEUE, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE, expireInSeconds: 600, retentionSeconds: 86400 });
  await instance.schedule(UPLOAD_EXPIRY_QUEUE, "*/15 * * * *", {}, { tz: "UTC" });
  await instance.schedule(EMBED_DISPATCH_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.schedule(THUMBNAIL_CLEANUP_QUEUE, "*/5 * * * *", {}, { tz: "UTC" });
  await instance.schedule(BILLING_RECONCILIATION_QUEUE, "*/5 * * * *", {}, { tz: "UTC" });
  await instance.schedule(ANALYTICS_ROLLUP_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.schedule(ANALYTICS_RETENTION_QUEUE, "17 3 * * *", {}, { tz: "UTC" });
  await instance.schedule(ONBOARDING_DISPATCH_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.schedule(CUSTOM_DOMAIN_REPAIR_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.schedule(MASTER_STORAGE_DISPATCH_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.work<HealthJob>(QUEUE_NAME, async ([job]: Job<HealthJob>[]) => {
    logger.info({ jobId: job.id, requestedAt: job.data.requestedAt }, "Job worker processed health check");
    return { processedAt: new Date().toISOString() };
  });
  await instance.work<BunnyRoundTripJob>(
    BUNNY_ROUNDTRIP_QUEUE,
    { batchSize: 1 },
    async ([job]: Job<BunnyRoundTripJob>[]) => {
      logger.info({ jobId: job.id }, "Starting Bunny adapter round trip");
      const result = await runBunnyRoundTrip(job.id);
      logger.info({ jobId: job.id, result }, "Completed Bunny adapter round trip");
      return result;
    },
  );
  await instance.work<TenantProvisionJob>(
    TENANT_PROVISION_QUEUE,
    { batchSize: 1 },
    async ([job]: Job<TenantProvisionJob>[]) => processOnboardingProvisioningJob(
      job.data.organizationId,
      options.resolveProvisioningProvider ?? resolveProvisioningProvider,
    ),
  );
  await instance.work(ONBOARDING_DISPATCH_QUEUE, { batchSize: 1 }, async () =>
    dispatchPendingOnboardingIntents(instance));
  await instance.work(UPLOAD_EXPIRY_QUEUE, { batchSize: 1 }, async () => cleanupExpiredUploads(
    options.resolveProvisioningProvider ?? resolveProvisioningProvider,
  ));
  await instance.work<{ videoId: string }>(
    EMBED_GENERATION_QUEUE,
    { batchSize: 1 },
    async ([job]) => generateVideoEmbed(job.data.videoId, job.id),
  );
  await instance.work(EMBED_DISPATCH_QUEUE, { batchSize: 1 }, async () => {
    const dispatched = await dispatchPendingEmbedOutbox(instance);
    const reconciled = await reconcileEmbedGenerationOutbox(instance);
    return { ...dispatched, ...reconciled };
  });
  await instance.work(THUMBNAIL_CLEANUP_QUEUE, { batchSize: 1 }, async () =>
    cleanupThumbnailObjects(options.thumbnailStorage));
  await instance.work(BILLING_RECONCILIATION_QUEUE, { batchSize: 1 }, async () => {
    const [receipts, billing] = await Promise.allSettled([
      reconcilePendingBillingReceipts(),
      reconcileActiveBilling(),
    ]);
    if (receipts.status === "rejected" || billing.status === "rejected") {
      throw new Error("billing_reconciliation_batch_retryable");
    }
    return { ...billing.value, receiptsReconciled: receipts.value.reconciled };
  });
  await instance.work(ANALYTICS_ROLLUP_QUEUE, { batchSize: 1 }, async () => processAnalyticsDirtyDays());
  await instance.work(ANALYTICS_RETENTION_QUEUE, { batchSize: 1 }, async () => purgeAnalyticsData());
  await instance.work<CustomDomainVerificationJob>(CUSTOM_DOMAIN_VERIFY_QUEUE, { batchSize: 1 }, async ([job]) =>
    processCustomDomainVerification(
      job.data.domainId,
      options.domainDnsResolver ?? nodeDomainDnsResolver,
      writeAuditEvent,
      job.data.dispatchClaim,
    ));
  await instance.work(CUSTOM_DOMAIN_REPAIR_QUEUE, { batchSize: 1 }, async () => repairCustomDomainVerifications(instance));
  await instance.work(MASTER_STORAGE_DISPATCH_QUEUE, { batchSize: 1 }, async () => dispatchMasterStorageOperations((job) => sendMasterStorageJob(instance, job.operationId, job.generation)));
  await instance.work<{ operationId: string; generation: number }>(MASTER_STORAGE_OPERATION_QUEUE, { batchSize: 1 }, async ([job]) => processMasterStorageOperation(job.data.operationId, undefined, undefined, job.data.generation));

      await dispatchPendingOnboardingIntents(instance);
      boss = instance;
      logger.info({ queue: QUEUE_NAME }, "Job queue and worker started");
      return instance;
    } catch (startupError) {
      try {
        await instance.stop({ graceful: true, timeout: 10_000 });
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "Job queue startup failed and cleanup was incomplete",
        );
      }
      throw startupError;
    }
  })();

  try {
    return await bossStart;
  } finally {
    bossStart = undefined;
  }
}

/** Deterministic persisted-job repair; no in-memory retry path exists. */
export async function enqueueCustomDomainVerification(domainId: string) {
  if (customDomainVerificationEnqueuer) return customDomainVerificationEnqueuer(domainId);
  const instance = boss ?? await startJobs();
  // A domain can be verified repeatedly over its lifetime. Reusing the domain
  // UUID as the pg-boss job ID lets a retained completed/dead-letter row
  // suppress a later request. The database claim in
  // processCustomDomainVerification provides single-flight execution.
  const dispatchClaim = await claimCustomDomainDispatch(domainId);
  if (!dispatchClaim) throw new Error("Custom-domain verification is not dispatchable");
  try {
    const jobId = `${domainId}:${randomUUID()}`;
    const id = await instance.send(
      CUSTOM_DOMAIN_VERIFY_QUEUE,
      { domainId, dispatchClaim },
      { id: jobId },
    );
    if (!id) throw new Error("Job queue rejected custom-domain verification");
    return id;
  } catch (error) {
    await releaseCustomDomainDispatch(domainId, dispatchClaim);
    throw error;
  }
}

export async function repairCustomDomainVerifications(instance?: PgBoss) {
  const queue = instance ?? boss ?? await startJobs();
  const candidates = await withWorkerDb("custom_domain", async (tx) => {
    // TXT lookup is read-only and idempotent, so stale workers can be retried
    // without operator reconciliation or duplicate external side effects.
    await tx.update(customDomainsTable).set({
      lifecycleState: "failed", retryable: true, retryAfterAt: new Date(),
      diagnosticCode: "verification_worker_interrupted", claimToken: null, claimedAt: null,
    }).where(and(
      eq(customDomainsTable.lifecycleState, "verifying"),
      lt(customDomainsTable.claimedAt, new Date(Date.now() - 10 * 60_000)),
    ));
    return tx.select({ id: customDomainsTable.id }).from(customDomainsTable).where(and(
      inArray(customDomainsTable.lifecycleState, ["pending_verification", "failed"]),
      eq(customDomainsTable.retryable, true),
      or(lt(customDomainsTable.retryAfterAt, new Date()), sql`${customDomainsTable.retryAfterAt} is null`),
    )).limit(100);
  });
  let queued = 0;
  for (const row of candidates) {
    const dispatchClaim = await claimCustomDomainDispatch(row.id);
    if (!dispatchClaim) continue;
    try {
      const id = await queue.send(
        CUSTOM_DOMAIN_VERIFY_QUEUE,
        { domainId: row.id, dispatchClaim },
        { id: `${row.id}:${randomUUID()}` },
      );
      if (!id) throw new Error("Job queue rejected custom-domain verification");
      queued++;
    } catch {
      await releaseCustomDomainDispatch(row.id, dispatchClaim);
    }
  }
  return { queued };
}

async function claimCustomDomainDispatch(domainId: string) {
  const claim = randomUUID();
  const [claimed] = await withWorkerDb("custom_domain", (tx) =>
    tx.update(customDomainsTable).set({
      lifecycleState: "verifying",
      claimToken: claim,
      claimedAt: new Date(),
    }).where(and(
      eq(customDomainsTable.id, domainId),
      inArray(customDomainsTable.lifecycleState, ["pending_verification", "failed"]),
      eq(customDomainsTable.retryable, true),
      or(lt(customDomainsTable.retryAfterAt, new Date()), sql`${customDomainsTable.retryAfterAt} is null`),
    )).returning({ id: customDomainsTable.id }));
  return claimed ? claim : undefined;
}

async function releaseCustomDomainDispatch(domainId: string, claim: string) {
  await withWorkerDb("custom_domain", (tx) =>
    tx.update(customDomainsTable).set({
      lifecycleState: "failed",
      claimToken: null,
      claimedAt: null,
      diagnosticCode: "verification_enqueue_failed",
      retryAfterAt: new Date(),
    }).where(and(
      eq(customDomainsTable.id, domainId),
      eq(customDomainsTable.lifecycleState, "verifying"),
      eq(customDomainsTable.claimToken, claim),
    )));
}

export async function stopJobs() {
  const pendingStart = bossStart;
  if (pendingStart) {
    try {
      await pendingStart;
    } catch {
      // startJobs owns cleanup for partially initialized instances.
    }
  }
  const instance = boss;
  boss = undefined;
  if (instance) await instance.stop({ graceful: true, timeout: 10_000 });
}

export async function enqueueHealthCheck() {
  const instance = boss ?? await startJobs();
  const id = await instance.send(QUEUE_NAME, { requestedAt: new Date().toISOString() });
  if (!id) throw new Error("Job queue rejected health check");
  return id;
}

/** Best-effort wake-up; the periodic dispatcher owns durable delivery. */
export async function enqueueMasterStorageDispatchWakeup() {
  const instance = boss;
  if (!instance) return;
  await instance.send(MASTER_STORAGE_DISPATCH_QUEUE, {}, { singletonKey: "master-storage-dispatch" });
}
async function sendMasterStorageJob(queue: PgBoss, operationId: string, generation: number) {
  const jobId = `${operationId}:${generation}`;
  const id = await queue.send(MASTER_STORAGE_OPERATION_QUEUE, { operationId, generation }, { id: jobId, singletonKey: jobId });
  if (id) return id;
  const [existing] = await queue.findJobs(MASTER_STORAGE_OPERATION_QUEUE, { id: jobId });
  if (!existing) throw new Error("Job queue rejected master-storage operation");
  return existing.id;
}

export async function findHealthCheck(id: string) {
  const instance = boss ?? await startJobs();
  const [job] = await instance.findJobs<HealthJob>(QUEUE_NAME, { id });
  return job;
}

/** The only entry point for tenant provisioning; routes must only enqueue this work. */
export async function enqueueTenantProvisioning(organizationId: string) {
  const instance = boss ?? await startJobs();
  const id = await instance.send(TENANT_PROVISION_QUEUE, { organizationId });
  if (!id) throw new Error("Job queue rejected tenant provisioning");
  return id;
}

/** Best-effort wake-up only; the persisted intent and periodic scan own delivery. */
export async function enqueueOnboardingDispatchWakeup() {
  const instance = boss;
  if (!instance) return;
  await instance.send(ONBOARDING_DISPATCH_QUEUE, {}, { singletonKey: "onboarding-outbox-wakeup" });
}

/** Claims and publishes persisted onboarding intents with one durable ID per delivery claim. */
export async function dispatchPendingOnboardingIntents(instance?: PgBoss) {
  const queue = instance ?? boss ?? await startJobs();
  await repairStaleOnboardingIntents();
  let dispatched = 0;
  for (let index = 0; index < 100; index++) {
    const candidate = await withWorkerDb("onboarding", async (tx) => {
      const staleBefore = new Date(Date.now() - 5 * 60_000);
      const staleWorkerBefore = new Date(Date.now() - 25 * 60_000);
      const claimable = or(
        eq(onboardingProvisioningIntentsTable.state, "pending"),
        and(
          eq(onboardingProvisioningIntentsTable.state, "dispatching"),
          lt(onboardingProvisioningIntentsTable.claimedAt, staleBefore),
        ),
        and(
          eq(onboardingProvisioningIntentsTable.state, "queued"),
          lt(onboardingProvisioningIntentsTable.dispatchedAt, staleWorkerBefore),
        ),
      );
      const [row] = await tx.select({
        id: onboardingProvisioningIntentsTable.id,
        organizationId: onboardingProvisioningIntentsTable.organizationId,
      }).from(onboardingProvisioningIntentsTable)
        .where(and(claimable, lt(onboardingProvisioningIntentsTable.attempts, 5)))
        .orderBy(onboardingProvisioningIntentsTable.createdAt).limit(1);
      if (!row) return undefined;
      const claim = randomUUID();
      const [claimed] = await tx.update(onboardingProvisioningIntentsTable).set({
        state: "dispatching", dispatchClaim: claim, claimedAt: new Date(),
      }).where(and(eq(onboardingProvisioningIntentsTable.id, row.id), claimable))
        .returning({ id: onboardingProvisioningIntentsTable.id });
      return claimed ? { ...row, claim } : undefined;
    });
    if (!candidate) break;
    try {
      await sendOnboardingProvisioningJob(
        queue,
        candidate.organizationId,
        candidate.id,
        candidate.claim,
      );
      await withWorkerDb("onboarding", async (tx) => {
        await tx.update(onboardingProvisioningIntentsTable).set({
          state: "queued", dispatchedAt: new Date(), dispatchClaim: null,
        }).where(and(
          eq(onboardingProvisioningIntentsTable.id, candidate.id),
          eq(onboardingProvisioningIntentsTable.dispatchClaim, candidate.claim),
        ));
      });
      dispatched++;
    } catch {
      await withWorkerDb("onboarding", async (tx) => {
        await tx.update(onboardingProvisioningIntentsTable).set({
          state: "pending", dispatchClaim: null, diagnosticCode: "enqueue_failed",
        }).where(and(
          eq(onboardingProvisioningIntentsTable.id, candidate.id),
          eq(onboardingProvisioningIntentsTable.dispatchClaim, candidate.claim),
        ));
      });
      // Leave the durable row pending for the next scheduled wake-up. Retrying
      // the same unavailable queue 100 times in one run creates a local storm
      // without improving delivery.
      break;
    }
  }
  return { dispatched };
}

async function sendOnboardingProvisioningJob(
  queue: PgBoss,
  organizationId: string,
  intentId: string,
  deliveryClaim: string,
) {
  const jobId = `${intentId}:${deliveryClaim}`;
  const id = await queue.send(
    TENANT_PROVISION_QUEUE,
    { organizationId },
    { id: jobId },
  );
  if (!id) throw new Error("Job queue rejected onboarding provisioning");
  return id;
}

async function repairStaleOnboardingIntents() {
  for (let index = 0; index < 100; index++) {
    const repaired = await withWorkerDb("onboarding", async (tx) => {
      const staleBefore = new Date(Date.now() - 25 * 60_000);
      const [row] = await tx.select({
        id: onboardingProvisioningIntentsTable.id,
        organizationId: onboardingProvisioningIntentsTable.organizationId,
        state: onboardingProvisioningIntentsTable.state,
        attempts: onboardingProvisioningIntentsTable.attempts,
        claimedAt: onboardingProvisioningIntentsTable.claimedAt,
        spaceId: providerTenantSpacesTable.id,
        externalCallClaim: providerTenantSpacesTable.externalCallClaim,
        externalCallClaimedAt: providerTenantSpacesTable.externalCallClaimedAt,
      }).from(onboardingProvisioningIntentsTable)
        .leftJoin(
          providerTenantSpacesTable,
          eq(
            providerTenantSpacesTable.organizationId,
            onboardingProvisioningIntentsTable.organizationId,
          ),
        )
        .where(or(
          and(
            eq(onboardingProvisioningIntentsTable.state, "processing"),
            lt(onboardingProvisioningIntentsTable.claimedAt, staleBefore),
          ),
          and(
            inArray(onboardingProvisioningIntentsTable.state, [
              "pending", "dispatching", "queued", "unavailable", "failed",
            ]),
            gte(onboardingProvisioningIntentsTable.attempts, 5),
            eq(onboardingProvisioningIntentsTable.retryable, true),
          ),
        ))
        .orderBy(onboardingProvisioningIntentsTable.createdAt)
        .limit(1);
      if (!row) return false;

      if (
        row.state === "processing"
        && row.externalCallClaim
        && row.externalCallClaimedAt
        && row.externalCallClaimedAt > staleBefore
      ) {
        await tx.update(onboardingProvisioningIntentsTable).set({
          claimedAt: row.externalCallClaimedAt,
        }).where(and(
          eq(onboardingProvisioningIntentsTable.id, row.id),
          eq(onboardingProvisioningIntentsTable.state, "processing"),
          lt(onboardingProvisioningIntentsTable.claimedAt, staleBefore),
        ));
        return true;
      }

      if (row.state === "processing" && row.externalCallClaim) {
        const [changed] = await tx.update(onboardingProvisioningIntentsTable).set({
          state: "reconciliation_required",
          retryable: false,
          diagnosticCode: "interrupted_external_call_claim",
        }).where(and(
          eq(onboardingProvisioningIntentsTable.id, row.id),
          eq(onboardingProvisioningIntentsTable.state, "processing"),
        )).returning({ id: onboardingProvisioningIntentsTable.id });
        if (!changed) return true;
        await tx.update(organizationsTable).set({ status: "failed" }).where(and(
          eq(organizationsTable.id, row.organizationId),
          eq(organizationsTable.status, "provisioning"),
        ));
        if (row.spaceId) {
          await tx.update(providerTenantSpacesTable).set({
            reconciliationRequired: true,
          }).where(and(
            eq(providerTenantSpacesTable.id, row.spaceId),
            eq(providerTenantSpacesTable.externalCallClaim, row.externalCallClaim),
          ));
        }
        await writeAuditEvent(tx, {
          organizationId: row.organizationId,
          actor: auditJob(),
          action: "provider.account_provisioning.reconciliation_required",
          category: "provider",
          subject: {
            type: "provider_tenant_space",
            id: row.spaceId ?? row.id,
            label: "reconciliation_required",
          },
          beforeState: { state: "processing" },
          afterState: { state: "reconciliation_required" },
          metadata: { code: "interrupted_external_call_claim" },
        });
        return true;
      }

      if (row.attempts >= 5) {
        const [changed] = await tx.update(onboardingProvisioningIntentsTable).set({
          state: "failed",
          retryable: false,
          dispatchClaim: null,
          diagnosticCode: "provisioning_attempts_exhausted",
        }).where(and(
          eq(onboardingProvisioningIntentsTable.id, row.id),
          inArray(onboardingProvisioningIntentsTable.state, [
            "pending", "dispatching", "queued", "processing", "unavailable", "failed",
          ]),
          eq(onboardingProvisioningIntentsTable.retryable, true),
        )).returning({ id: onboardingProvisioningIntentsTable.id });
        if (!changed) return true;
        const [failedOrganization] = await tx.update(organizationsTable)
          .set({ status: "failed" })
          .where(and(
            eq(organizationsTable.id, row.organizationId),
            eq(organizationsTable.status, "provisioning"),
          ))
          .returning({ name: organizationsTable.name });
        if (failedOrganization) {
          await writeAuditEvent(tx, {
            organizationId: row.organizationId,
            actor: auditJob(),
            action: "workspace.onboarding_failed",
            category: "workspace",
            subject: {
              type: "organization",
              id: row.organizationId,
              label: failedOrganization.name,
            },
            beforeState: { status: "provisioning" },
            afterState: { status: "failed", retryable: false },
            metadata: { code: "provisioning_attempts_exhausted" },
          });
        }
        return true;
      }

      await tx.update(onboardingProvisioningIntentsTable).set({
        state: "pending",
        dispatchClaim: null,
        claimedAt: null,
        diagnosticCode: "interrupted_before_external_call",
      }).where(and(
        eq(onboardingProvisioningIntentsTable.id, row.id),
        eq(onboardingProvisioningIntentsTable.state, "processing"),
      ));
      return true;
    });
    if (!repaired) break;
  }
}

export async function processOnboardingProvisioningJob(
  organizationId: string,
  resolver: ProvisioningProviderResolver,
) {
  const shouldRun = await withWorkerDb("onboarding", async (tx) => {
    const claimable = or(
      inArray(onboardingProvisioningIntentsTable.state, ["queued", "pending", "dispatching"]),
      and(
        inArray(onboardingProvisioningIntentsTable.state, ["failed", "unavailable"]),
        eq(onboardingProvisioningIntentsTable.retryable, true),
      ),
    );
    const [intent] = await tx.update(onboardingProvisioningIntentsTable).set({
      state: "processing",
      attempts: sql`${onboardingProvisioningIntentsTable.attempts} + 1`,
      claimedAt: new Date(),
    })
      .where(and(
        eq(onboardingProvisioningIntentsTable.organizationId, organizationId),
        claimable,
        lt(onboardingProvisioningIntentsTable.attempts, 5),
      )).returning({ id: onboardingProvisioningIntentsTable.id });
    return Boolean(intent);
  });
  if (!shouldRun) return { organizationId, skipped: true };
  try {
    return await provisionTenantOrganization(organizationId, resolver);
  } catch (error) {
    await withWorkerDb("onboarding", async (tx) => {
      const [intent] = await tx.select().from(onboardingProvisioningIntentsTable)
        .where(eq(onboardingProvisioningIntentsTable.organizationId, organizationId)).limit(1);
      if (!intent || intent.state === "reconciliation_required" || intent.state === "completed") return;
      const unavailable = error instanceof ProvisioningUnavailableError;
      const retryable = intent.attempts < 5;
      await tx.update(onboardingProvisioningIntentsTable).set({
        state: unavailable ? "unavailable" : "failed",
        retryable,
        diagnosticCode: unavailable ? "provider_unavailable" : "provisioning_failed",
      }).where(eq(onboardingProvisioningIntentsTable.id, intent.id));
      const [organization] = await tx.update(organizationsTable).set({ status: "failed" })
        .where(and(
          eq(organizationsTable.id, organizationId),
          eq(organizationsTable.status, "provisioning"),
        ))
        .returning({ name: organizationsTable.name });
      if (organization) await writeAuditEvent(tx, {
        organizationId, actor: auditJob(), action: "workspace.onboarding_failed", category: "workspace",
        subject: { type: "organization", id: organizationId, label: organization.name },
        beforeState: { status: "provisioning" },
        afterState: { status: "failed", retryable },
        metadata: { code: unavailable ? "provider_unavailable" : "provisioning_failed" },
      });
    });
    throw error;
  }
}

/** Step 10 outbox target. Payload deliberately contains only the owned UUID. */
export async function enqueueEmbedGeneration(videoId: string, outboxId: string) {
  const instance = boss ?? await startJobs();
  return sendEmbedGenerationJob(instance, videoId, outboxId);
}

/** Wakes the dispatcher after commit. Correctness comes from its scheduled scan. */
export async function enqueueEmbedDispatchWakeup() {
  if (embedDispatchWakeupForTest) return embedDispatchWakeupForTest();
  const instance = boss ?? await startJobs();
  await instance.send(EMBED_DISPATCH_QUEUE, {}, { singletonKey: "outbox-wakeup" });
}

/** Exposed for deterministic smoke verification; safe to call concurrently. */
export async function dispatchPendingEmbedOutbox(instance?: PgBoss) {
  const queue = instance ?? boss ?? await startJobs();
  let dispatched = 0;
  const repairHorizon = new Date(Date.now() - 23 * 60 * 60_000);
  await withWorkerDb("embed", (tx) =>
    tx.update(embedGenerationOutboxTable).set({
      state: "reconciliation_required",
      dispatchClaim: null,
      diagnosticCode: "dispatch_outcome_unknown_after_retention_horizon",
    }).where(and(
      eq(embedGenerationOutboxTable.state, "dispatching"),
      lt(embedGenerationOutboxTable.claimedAt, repairHorizon),
    )));
  for (let i = 0; i < 100; i++) {
    const claim = randomUUID();
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const claimable = or(
      eq(embedGenerationOutboxTable.state, "pending"),
      and(
        eq(embedGenerationOutboxTable.state, "dispatching"),
        gte(embedGenerationOutboxTable.claimedAt, repairHorizon),
        lt(embedGenerationOutboxTable.claimedAt, staleBefore),
      ),
    );
    const candidate = await withWorkerDb("embed", async (tx) => {
      const [row] = await tx.select({ id: embedGenerationOutboxTable.id, videoId: embedGenerationOutboxTable.videoId })
        .from(embedGenerationOutboxTable)
        .where(claimable)
        .orderBy(embedGenerationOutboxTable.createdAt)
        .limit(1);
      if (!row) return undefined;
      const [claimed] = await tx.update(embedGenerationOutboxTable).set({
        state: "dispatching", dispatchClaim: claim, claimedAt: new Date(), attemptedAt: new Date(),
        attempts: sql`${embedGenerationOutboxTable.attempts} + 1`,
        diagnosticCode: null,
      }).where(and(
        eq(embedGenerationOutboxTable.id, row.id),
        claimable,
      )).returning({ id: embedGenerationOutboxTable.id });
      return claimed ? row : undefined;
    });
    if (!candidate) break;
    try {
      await sendEmbedGenerationJob(queue, candidate.videoId, candidate.id);
      await withWorkerDb("embed", (tx) =>
        tx.update(embedGenerationOutboxTable).set({
          state: "dispatched", dispatchedAt: new Date(), dispatchClaim: null,
        }).where(and(
          eq(embedGenerationOutboxTable.id, candidate.id),
          eq(embedGenerationOutboxTable.dispatchClaim, claim),
        )));
      dispatched++;
    } catch {
      await withWorkerDb("embed", (tx) =>
        tx.update(embedGenerationOutboxTable).set({
          state: "pending", dispatchClaim: null, diagnosticCode: "enqueue_failed",
        }).where(and(
          eq(embedGenerationOutboxTable.id, candidate.id),
          eq(embedGenerationOutboxTable.dispatchClaim, claim),
        )));
    }
  }
  return { dispatched };
}

/**
 * Repairs only known terminal generation jobs. A missing job is ambiguous until
 * pg-boss retention has elapsed, then it is quarantined instead of replayed.
 * Recovery is DB-only and retains the original deterministic outbox/job id.
 */
export async function reconcileEmbedGenerationOutbox(instance?: PgBoss) {
  const queue = instance ?? boss ?? await startJobs();
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const retentionHorizon = new Date(Date.now() - 23 * 60 * 60_000);
  const candidates = await withWorkerDb("embed", (tx) =>
    tx.select({
      id: embedGenerationOutboxTable.id,
      videoId: embedGenerationOutboxTable.videoId,
      dispatchedAt: embedGenerationOutboxTable.dispatchedAt,
    }).from(embedGenerationOutboxTable).where(and(
      eq(embedGenerationOutboxTable.state, "dispatched"),
      lt(embedGenerationOutboxTable.dispatchedAt, staleBefore),
    )).limit(100));
  let recovered = 0;
  let quarantined = 0;
  for (const candidate of candidates) {
    const [job] = await queue.findJobs(EMBED_GENERATION_QUEUE, { id: candidate.id });
    if (job?.state === "failed" || job?.state === "completed") {
      await generateVideoEmbed(candidate.videoId, candidate.id);
      recovered++;
      continue;
    }
    if (!job && candidate.dispatchedAt && candidate.dispatchedAt < retentionHorizon) {
      const changed = await withWorkerDb("embed", async (tx) => {
        const [row] = await tx.update(embedGenerationOutboxTable).set({
          state: "reconciliation_required",
          diagnosticCode: "generation_job_missing_after_retention_horizon",
        }).where(and(
          eq(embedGenerationOutboxTable.id, candidate.id),
          eq(embedGenerationOutboxTable.state, "dispatched"),
        )).returning({ id: embedGenerationOutboxTable.id });
        if (!row) return [];
        const [video] = await tx.select({
          organizationId: videosTable.organizationId, title: videosTable.title,
        }).from(videosTable).where(eq(videosTable.id, candidate.videoId)).limit(1);
        if (video) await writeAuditEvent(tx, {
          organizationId: video.organizationId, actor: auditJob(), action: "embed.generation_failed", category: "embed",
          subject: { type: "video", id: candidate.videoId, label: video.title },
          beforeState: { outboxState: "dispatched" },
          afterState: { outboxState: "reconciliation_required", generationVersion: 1 },
          metadata: { code: "generation_job_missing_after_retention_horizon" },
        });
        return [row];
      });
      quarantined += changed.length;
    }
  }
  return { recovered, quarantined };
}

async function sendEmbedGenerationJob(queue: PgBoss, videoId: string, outboxId: string) {
  const jobId = await queue.send(
    EMBED_GENERATION_QUEUE,
    { videoId },
    { id: outboxId, singletonKey: outboxId },
  );
  if (jobId) return jobId;
  const [existing] = await queue.findJobs(EMBED_GENERATION_QUEUE, { id: outboxId });
  if (!existing) throw new Error("Job queue rejected embed generation");
  return existing.id;
}