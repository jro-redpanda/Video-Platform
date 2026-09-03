type RuntimeLogger = {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
};

type RuntimeServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
};

export type ShutdownController = {
  isShuttingDown(): boolean;
  shutdown(reason: string): Promise<void>;
};

function closeServer(server: RuntimeServer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      finish(new Error("HTTP server did not drain before the shutdown deadline"));
    }, timeoutMs);
    timeout.unref?.();

    try {
      server.close((error) => finish(error));
      server.closeIdleConnections?.();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("HTTP server close failed"));
    }
  });
}

export function createShutdownController(options: {
  server: RuntimeServer;
  stopWorkers(): Promise<void>;
  setReady(ready: boolean): void;
  logger: RuntimeLogger;
  timeoutMs?: number;
}): ShutdownController {
  let shutdownPromise: Promise<void> | undefined;

  return {
    isShuttingDown: () => shutdownPromise !== undefined,
    shutdown(reason: string) {
      if (shutdownPromise) return shutdownPromise;
      options.setReady(false);
      options.logger.info({ reason }, "Shutting down API");

      shutdownPromise = (async () => {
        const results = await Promise.allSettled([
          closeServer(options.server, options.timeoutMs ?? 10_000),
          options.stopWorkers(),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length) {
          options.logger.error(
            { failedOperations: failures.length },
            "API shutdown completed with errors",
          );
          throw new AggregateError(failures, "API shutdown failed");
        }
      })();
      return shutdownPromise;
    },
  };
}

export async function startRuntime(options: {
  listen(): Promise<RuntimeServer>;
  bootstrap(): Promise<void>;
  initializeExternal(): Promise<void>;
  startWorkers(): Promise<unknown>;
  stopWorkers(): Promise<void>;
  setReady(ready: boolean): void;
  logger: RuntimeLogger;
  onShutdownController?(controller: ShutdownController): void;
  shutdownTimeoutMs?: number;
}) {
  options.setReady(false);
  // Binding is the only step before the server exists. All database, provider,
  // and worker effects happen only after bind succeeds.
  const server = await options.listen();
  const controller = createShutdownController({
    server,
    stopWorkers: options.stopWorkers,
    setReady: options.setReady,
    logger: options.logger,
    timeoutMs: options.shutdownTimeoutMs,
  });
  options.onShutdownController?.(controller);

  try {
    await options.bootstrap();
    if (controller.isShuttingDown()) return { server, controller };
    await options.initializeExternal();
    if (controller.isShuttingDown()) return { server, controller };
    await options.startWorkers();
    if (controller.isShuttingDown()) return { server, controller };
    options.setReady(true);
    return { server, controller };
  } catch (startupError) {
    try {
      await controller.shutdown("startup failure");
    } catch (shutdownError) {
      throw new AggregateError(
        [startupError, shutdownError],
        "API startup failed and cleanup was incomplete",
      );
    }
    throw startupError;
  }
}