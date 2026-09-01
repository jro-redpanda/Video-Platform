import { PgBoss, events, type Job } from "pg-boss";
import { logger } from "./logger";
import { runBunnyRoundTrip } from "./bunny-roundtrip";

const QUEUE_NAME = "vid.system.health";
const DEAD_LETTER_QUEUE = "vid.system.dead-letter";
export const BUNNY_ROUNDTRIP_QUEUE = "vid.provider.bunny-roundtrip";

type HealthJob = {
  requestedAt: string;
};

type BunnyRoundTripJob = {
  requestedAt: string;
};

let boss: PgBoss | undefined;

export async function startJobs() {
  if (boss) return boss;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the job queue");

  const instance = new PgBoss({
    connectionString,
    schema: "vid_jobs",
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