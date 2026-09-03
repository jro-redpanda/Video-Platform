import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

Object.assign(process.env, {
  NODE_ENV: "test",
  PORT: "3000",
  PRODUCT_NAME: "Runtime Test",
  VID_APP_DOMAIN: "example.test",
  SESSION_SECRET: "local-test-secret-that-is-at-least-32-characters",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
  LOG_LEVEL: "silent",
  STRIPE_SYNC_IN_TEST: "false",
});

const { loadStartupConfig, parsePort } = await import("./lib/config");
const { createApp, setApplicationReady } = await import("./app");
const { createShutdownController, startRuntime } = await import("./lib/runtime-lifecycle");
const { startJobs } = await import("./lib/jobs");

type HttpResult = { status: number; body: Buffer; headers: NodeJS.Dict<string | string[]> };

function httpRequest(
  server: Server,
  path: string,
  options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-length": String(options.body.length) } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
        headers: res.headers,
      }));
    });
    req.once("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "3000",
    PRODUCT_NAME: "Runtime Test",
    VID_APP_DOMAIN: "Example.TEST.",
    SESSION_SECRET: "local-test-secret-that-is-at-least-32-characters",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    LOG_LEVEL: "silent",
    STRIPE_SYNC_IN_TEST: "false",
    ...overrides,
  };
}

async function testConfiguration() {
  assert.deepEqual(loadStartupConfig(validEnvironment()), { nodeEnv: "test", port: 3000 });
  for (const value of [undefined, "", "0", "-1", "1.5", "65536", "Infinity", "abc"]) {
    assert.throws(() => parsePort(value), /PORT/);
  }
  assert.throws(
    () => loadStartupConfig(validEnvironment({ NODE_ENV: "staging" })),
    /NODE_ENV/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({ SESSION_SECRET: "too-short" })),
    /SESSION_SECRET/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({ VID_APP_DOMAIN: "https:\/\/example.test/path" })),
    /VID_APP_DOMAIN/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({ DATABASE_URL: "https://example.test" })),
    /DATABASE_URL/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({
      NODE_ENV: "production",
      REPLIT_DOMAINS: undefined,
    })),
    /REPLIT_DOMAINS/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({
      NODE_ENV: "production",
      REPLIT_DOMAINS: "example.test",
      REPLIT_CONNECTORS_HOSTNAME: undefined,
    })),
    /REPLIT_CONNECTORS_HOSTNAME/,
  );
  assert.throws(
    () => loadStartupConfig(validEnvironment({
      NODE_ENV: "production",
      REPLIT_DOMAINS: "example.test",
      REPLIT_CONNECTORS_HOSTNAME: "connectors.example.test",
      REPL_IDENTITY: undefined,
      WEB_REPL_RENEWAL: undefined,
    })),
    /workload identity/,
  );
}

async function testCompositionAndRawBodies() {
  const stripeBody = Buffer.from('{"id":"evt_local","token":"body-must-remain-exact"}');
  const bunnyBody = Buffer.from('{"VideoGuid":"video-local"}');
  let observedStripeBody: Buffer | undefined;
  let observedBunnyBody: Buffer | undefined;
  const app = createApp({
    initialReady: false,
    stripeWebhookHandler: async (body) => {
      observedStripeBody = Buffer.from(body);
    },
    bunnyRoundTripHandler: (_token, body) => {
      observedBunnyBody = Buffer.from(body);
      return { accepted: true, terminal: true };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    assert.equal((await httpRequest(server, "/api/healthz")).status, 200);
    const starting = await httpRequest(server, "/api/public/runtime-config");
    assert.equal(starting.status, 503);
    assert.equal(starting.headers["retry-after"], "1");

    setApplicationReady(app, true);
    assert.equal((await httpRequest(server, "/api/public/runtime-config")).status, 200);

    const stripe = await httpRequest(server, "/api/stripe/webhook", {
      method: "POST",
      body: stripeBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "local-signature",
      },
    });
    assert.equal(stripe.status, 200);
    assert.deepEqual(observedStripeBody, stripeBody);

    const bunny = await httpRequest(server, "/api/provider-tests/bunny/local-token", {
      method: "POST",
      body: bunnyBody,
      headers: { "content-type": "application/json" },
    });
    assert.equal(bunny.status, 204);
    assert.deepEqual(observedBunnyBody, bunnyBody);

    assert.equal((await httpRequest(server, "/api/stripe/webhook", {
      method: "POST",
      body: stripeBody,
      headers: { "content-type": "application/json" },
    })).status, 400);
  } finally {
    await close(server);
  }
}

const silentLogger = {
  info() {},
  error() {},
};

async function testRuntimeRollbackAndShutdown() {
  const events: string[] = [];
  const fakeServer = {
    close(callback: (error?: Error) => void) {
      events.push("close");
      setTimeout(() => {
        events.push("closed");
        callback();
      }, 5);
      return this;
    },
    closeIdleConnections() {
      events.push("close-idle");
    },
    closeAllConnections() {
      events.push("close-all");
    },
  };
  const readiness: boolean[] = [];
  const controller = createShutdownController({
    server: fakeServer,
    stopWorkers: async () => {
      events.push("stop-workers");
    },
    setReady: (ready) => readiness.push(ready),
    logger: silentLogger,
    timeoutMs: 100,
  });
  const first = controller.shutdown("test");
  const second = controller.shutdown("duplicate");
  assert.strictEqual(first, second);
  await first;
  assert.deepEqual(readiness, [false]);
  assert.equal(events.filter((event) => event === "close").length, 1);
  assert.equal(events.filter((event) => event === "stop-workers").length, 1);
  assert.equal(events.includes("closed"), true);
  assert.equal(events.includes("close-all"), false);

  const startupEvents: string[] = [];
  const startupServer = {
    close(callback: (error?: Error) => void) {
      startupEvents.push("close");
      callback();
      return this;
    },
  };
  await assert.rejects(
    startRuntime({
      listen: async () => {
        startupEvents.push("listen");
        return startupServer;
      },
      bootstrap: async () => {
        startupEvents.push("bootstrap");
        throw new Error("local bootstrap failure");
      },
      initializeExternal: async () => {
        startupEvents.push("external");
      },
      startWorkers: async () => {
        startupEvents.push("workers");
      },
      stopWorkers: async () => {
        startupEvents.push("stop-workers");
      },
      setReady: (ready) => startupEvents.push(`ready:${ready}`),
      logger: silentLogger,
    }),
    /local bootstrap failure/,
  );
  assert.deepEqual(startupEvents, [
    "ready:false",
    "listen",
    "bootstrap",
    "ready:false",
    "close",
    "stop-workers",
  ]);

  const bindEvents: string[] = [];
  await assert.rejects(
    startRuntime({
      listen: async () => {
        bindEvents.push("listen");
        throw new Error("address in use");
      },
      bootstrap: async () => {
        bindEvents.push("bootstrap");
      },
      initializeExternal: async () => {
        bindEvents.push("external");
      },
      startWorkers: async () => {
        bindEvents.push("workers");
      },
      stopWorkers: async () => {
        bindEvents.push("stop-workers");
      },
      setReady: (ready) => bindEvents.push(`ready:${ready}`),
      logger: silentLogger,
    }),
    /address in use/,
  );
  assert.deepEqual(bindEvents, ["ready:false", "listen"]);
}

async function testPartialWorkerStartupCleanup() {
  let stops = 0;
  let factories = 0;
  const partialBoss = {
    on() {
      return this;
    },
    async start() {},
    async createQueue() {
      throw new Error("local queue setup failure");
    },
    async stop() {
      stops += 1;
    },
  };

  await assert.rejects(
    startJobs({
      bossFactory: () => {
        factories += 1;
        return partialBoss as never;
      },
    }),
    /local queue setup failure/,
  );
  await assert.rejects(
    startJobs({
      bossFactory: () => {
        factories += 1;
        return partialBoss as never;
      },
    }),
    /local queue setup failure/,
  );
  assert.equal(stops, 2);
  assert.equal(factories, 2);
}

await testConfiguration();
await testCompositionAndRawBodies();
await testRuntimeRollbackAndShutdown();
await testPartialWorkerStartupCleanup();
console.log("G0 runtime smoke passed");