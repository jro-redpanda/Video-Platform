import { PgBoss } from "pg-boss";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const queue = new PgBoss({ connectionString, schema: "vid_jobs", migrate: false });
await queue.start();

try {
  const id = await queue.send("vid.system.health", {
    requestedAt: new Date().toISOString(),
  });
  if (!id) throw new Error("Queue rejected the smoke-test job");

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [job] = await queue.findJobs("vid.system.health", { id });
    if (job?.state === "completed") {
      console.log(JSON.stringify({ id, state: job.state, output: job.output }));
      process.exitCode = 0;
      break;
    }
    if (job?.state === "failed" || job?.state === "cancelled") {
      throw new Error(`Health job ended in state ${job.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (process.exitCode === undefined) {
    throw new Error("Timed out waiting for the worker to process the health job");
  }
} finally {
  await queue.stop({ graceful: true, timeout: 5_000 });
}