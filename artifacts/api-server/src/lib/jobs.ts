import { PgBoss, events, type Job } from "pg-boss";
import { logger } from "./logger";
import { runBunnyRoundTrip } from "./bunny-roundtrip";
import { provisionTenantOrganization } from "./tenant-provisioning";
import { resolveProvisioningProvider, type ProvisioningProviderResolver } from "./provider-registry";
import { cleanupExpiredUploads } from "./upload-expiry-cleanup";
import { generateVideoEmbed } from "./video-embeds";
import { cleanupThumbnailObjects } from "./thumbnail-cleanup";
import type { ThumbnailStorage } from "./thumbnail-storage";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { db, embedGenerationOutboxTable } from "@workspace/db";
import { randomUUID } from "node:crypto";

const queueSuffix = process.env.JOB_QUEUE_NAMESPACE ? `.${process.env.JOB_QUEUE_NAMESPACE}` : "";
const QUEUE_NAME = `vid.system.health${queueSuffix}`;
const DEAD_LETTER_QUEUE = `vid.system.dead-letter${queueSuffix}`;
export const BUNNY_ROUNDTRIP_QUEUE = `vid.provider.bunny-roundtrip${queueSuffix}`;
export const TENANT_PROVISION_QUEUE = `vid.tenant.provision${queueSuffix}`;
export const UPLOAD_EXPIRY_QUEUE = `vid.upload.expiry-cleanup${queueSuffix}`;
export const EMBED_GENERATION_QUEUE = `vid.video.embed-generation${queueSuffix}`;
export const EMBED_DISPATCH_QUEUE = `vid.video.embed-dispatch${queueSuffix}`;
export const THUMBNAIL_CLEANUP_QUEUE = `vid.thumbnail.cleanup${queueSuffix}`;

type HealthJob = {
  requestedAt: string;
};

type BunnyRoundTripJob = {
  requestedAt: string;
};
type TenantProvisionJob = { organizationId: string };

let boss: PgBoss | undefined;

export async function startJobs(options: {
  resolveProvisioningProvider?: ProvisioningProviderResolver;
  thumbnailStorage?: ThumbnailStorage;
} = {}) {
  if (boss) return boss;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the job queue");

  const instance = new PgBoss({
    connectionString,
    schema: "vid_jobs",
    migrate: false,
    application_name: "vid-api-worker",
  });
  instance.on(events.error, (error) => logger.error({ error }, "Job queue error"));

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
  await instance.schedule(UPLOAD_EXPIRY_QUEUE, "*/15 * * * *", {}, { tz: "UTC" });
  await instance.schedule(EMBED_DISPATCH_QUEUE, "* * * * *", {}, { tz: "UTC" });
  await instance.schedule(THUMBNAIL_CLEANUP_QUEUE, "*/5 * * * *", {}, { tz: "UTC" });
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
    async ([job]: Job<TenantProvisionJob>[]) => provisionTenantOrganization(
      job.data.organizationId,
      options.resolveProvisioningProvider ?? resolveProvisioningProvider,
    ),
  );
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

  boss = instance;
  logger.info({ queue: QUEUE_NAME }, "Job queue and worker started");
  return instance;
}

export async function stopJobs() {
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

/** Step 10 outbox target. Payload deliberately contains only the owned UUID. */
export async function enqueueEmbedGeneration(videoId: string, outboxId: string) {
  const instance = boss ?? await startJobs();
  return sendEmbedGenerationJob(instance, videoId, outboxId);
}

/** Wakes the dispatcher after commit. Correctness comes from its scheduled scan. */
export async function enqueueEmbedDispatchWakeup() {
  const instance = boss ?? await startJobs();
  await instance.send(EMBED_DISPATCH_QUEUE, {}, { singletonKey: "outbox-wakeup" });
}

/** Exposed for deterministic smoke verification; safe to call concurrently. */
export async function dispatchPendingEmbedOutbox(instance?: PgBoss) {
  const queue = instance ?? boss ?? await startJobs();
  let dispatched = 0;
  const repairHorizon = new Date(Date.now() - 23 * 60 * 60_000);
  await db.update(embedGenerationOutboxTable).set({
    state: "reconciliation_required",
    dispatchClaim: null,
    diagnosticCode: "dispatch_outcome_unknown_after_retention_horizon",
  }).where(and(
    eq(embedGenerationOutboxTable.state, "dispatching"),
    lt(embedGenerationOutboxTable.claimedAt, repairHorizon),
  ));
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
    const [candidate] = await db.select({ id: embedGenerationOutboxTable.id, videoId: embedGenerationOutboxTable.videoId })
      .from(embedGenerationOutboxTable)
      .where(claimable)
      .orderBy(embedGenerationOutboxTable.createdAt)
      .limit(1);
    if (!candidate) break;
    const claimed = await db.update(embedGenerationOutboxTable).set({
      state: "dispatching", dispatchClaim: claim, claimedAt: new Date(), attemptedAt: new Date(),
      attempts: sql`${embedGenerationOutboxTable.attempts} + 1`,
      diagnosticCode: null,
    }).where(and(
      eq(embedGenerationOutboxTable.id, candidate.id),
      claimable,
    )).returning({ id: embedGenerationOutboxTable.id });
    if (!claimed.length) continue;
    try {
      await sendEmbedGenerationJob(queue, candidate.videoId, candidate.id);
      await db.update(embedGenerationOutboxTable).set({
        state: "dispatched", dispatchedAt: new Date(), dispatchClaim: null,
      }).where(and(
        eq(embedGenerationOutboxTable.id, candidate.id),
        eq(embedGenerationOutboxTable.dispatchClaim, claim),
      ));
      dispatched++;
    } catch {
      await db.update(embedGenerationOutboxTable).set({
        state: "pending", dispatchClaim: null, diagnosticCode: "enqueue_failed",
      }).where(and(
        eq(embedGenerationOutboxTable.id, candidate.id),
        eq(embedGenerationOutboxTable.dispatchClaim, claim),
      ));
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
  const candidates = await db.select({
    id: embedGenerationOutboxTable.id,
    videoId: embedGenerationOutboxTable.videoId,
    dispatchedAt: embedGenerationOutboxTable.dispatchedAt,
  }).from(embedGenerationOutboxTable).where(and(
    eq(embedGenerationOutboxTable.state, "dispatched"),
    lt(embedGenerationOutboxTable.dispatchedAt, staleBefore),
  )).limit(100);
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
      const changed = await db.update(embedGenerationOutboxTable).set({
        state: "reconciliation_required",
        diagnosticCode: "generation_job_missing_after_retention_horizon",
      }).where(and(
        eq(embedGenerationOutboxTable.id, candidate.id),
        eq(embedGenerationOutboxTable.state, "dispatched"),
      )).returning({ id: embedGenerationOutboxTable.id });
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