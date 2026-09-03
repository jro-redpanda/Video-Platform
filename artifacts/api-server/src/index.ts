import type { Server } from "node:http";
import { loadStartupConfig } from "./lib/config";
import { startRuntime, type ShutdownController } from "./lib/runtime-lifecycle";

function listenForConnections(startServer: () => Server): Promise<Server> {
  return new Promise((resolve, reject) => {
    let server: Server;
    try {
      server = startServer();
    } catch (error) {
      reject(error);
      return;
    }

    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

async function main() {
  // This import is intentionally the first runtime action: it validates every
  // prerequisite before modules that initialize database/provider clients load.
  const startupConfig = loadStartupConfig(process.env);
  const [
    { default: app, setApplicationReady },
    { bootstrapDevelopmentTenant },
    { initializeStripeSync },
    { startJobs, stopJobs },
    { logger, summarizeError },
  ] = await Promise.all([
    import("./app"),
    import("./lib/bootstrap"),
    import("./lib/stripe-startup"),
    import("./lib/jobs"),
    import("./lib/logger"),
  ]);

  let receivedSignal = false;
  const registerSignals = (controller: ShutdownController) => {
    const handleSignal = (signal: "SIGTERM" | "SIGINT") => {
      receivedSignal = true;
      void controller.shutdown(signal).then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
    process.once("SIGINT", () => handleSignal("SIGINT"));
  };

  try {
    const { controller } = await startRuntime({
      listen: () => listenForConnections(() => app.listen(startupConfig.port)),
      bootstrap: bootstrapDevelopmentTenant,
      initializeExternal: initializeStripeSync,
      startWorkers: startJobs,
      stopWorkers: stopJobs,
      setReady: (ready) => setApplicationReady(app, ready),
      logger,
      onShutdownController: registerSignals,
    });
    if (!controller.isShuttingDown()) {
      logger.info({ port: startupConfig.port }, "API server ready");
    }
  } catch (error) {
    logger.error({ error: summarizeError(error) }, "API startup failed");
    process.exitCode = 1;
  }

  if (receivedSignal) process.exitCode ??= 0;
}

await main();