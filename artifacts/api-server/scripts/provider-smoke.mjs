import { PgBoss } from "pg-boss";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const queueName = "vid.provider.bunny-roundtrip";
const queue = new PgBoss({ connectionString, schema: "vid_jobs" });
await queue.start();

try {
  const id = await queue.send(queueName, { requestedAt: new Date().toISOString() });
  if (!id) throw new Error("Queue rejected the Bunny round-trip job");
  const deadline = Date.now() + 16 * 60_000;
  while (Date.now() < deadline) {
    const [job] = await queue.findJobs(queueName, { id });
    if (job?.state === "completed") {
      console.log(JSON.stringify({ id, state: job.state, output: job.output }, null, 2));
      process.exitCode = 0;
      break;
    }
    if (job?.state === "failed" || job?.state === "cancelled") {
      throw new Error(`Bunny round-trip job ended in ${job.state}: ${JSON.stringify(job.output)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (process.exitCode === undefined) throw new Error("Timed out waiting for the Bunny round-trip job");
} finally {
  await queue.stop({ graceful: true, timeout: 5_000 });
}