import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  AssetCreationRejectedError,
  EncodeCompletionCallbackRejectedError,
  TenantSpaceCreationRejectedError,
} from "./contracts.js";
import {
  BunnyApiError,
  BunnyVideoProvider,
  inspectBunnyEncodeCompletionCallback,
  type BunnyLibraryCredentials,
} from "./bunny/index.js";

type StubReply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function createFetchStub(replies: StubReply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status,
      headers: {
        ...(body === null ? {} : { "content-type": "application/json" }),
        ...reply.headers,
      },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, remaining: replies };
}

function credentials(overrides: Partial<BunnyLibraryCredentials> = {}): BunnyLibraryCredentials {
  return {
    libraryId: "123",
    apiKey: "library-api-key",
    readOnlyApiKey: "read-only-api-key",
    pullZoneId: "456",
    pullZoneHostname: "tenant-123.b-cdn.net",
    zoneSecurityKey: "zone-security-key",
    zoneSecurityEnabled: true,
    ...overrides,
  };
}

function signedCallback(input: {
  body: Record<string, unknown>;
  key?: string;
  signature?: string;
}) {
  const rawBody = Buffer.from(JSON.stringify(input.body));
  return {
    rawBody,
    headers: {
      "x-bunnystream-signature-version": "v1",
      "x-bunnystream-signature-algorithm": "hmac-sha256",
      "x-bunnystream-signature": input.signature
        ?? createHmac("sha256", input.key ?? "read-only-api-key").update(rawBody).digest("hex"),
    },
  };
}

async function testProvisioningAndCredentialRetention() {
  const stub = createFetchStub([
    {
      status: 201,
      body: {
        Id: 123,
        PullZoneId: 456,
        ApiKey: " library-api-key ",
        ReadOnlyApiKey: " read-only-api-key ",
      },
    },
    {
      status: 200,
      body: {
        Hostnames: [{ Value: "TENANT-123.B-CDN.NET" }],
        ZoneSecurityKey: " zone-security-key ",
        ZoneSecurityEnabled: true,
      },
    },
    { status: 204 },
    { status: 503, body: { secret: "must-not-leak" } },
    { status: 204 },
  ]);
  let persisted: BunnyLibraryCredentials | undefined;
  const provider = new BunnyVideoProvider({
    accountApiKey: " account-key ",
    fetch: stub.fetch,
    now: () => Date.UTC(2030, 0, 1),
    onLibraryCreated: async (library) => {
      persisted = library;
    },
  });
  const space = await provider.createTenantSpace({ name: " Tenant " });
  assert.deepEqual(space, { id: "123" });
  assert.deepEqual(persisted, credentials());
  assert.equal(JSON.parse(String(stub.calls[0].init?.body)).Name, "Tenant");
  assert.equal(new Headers(stub.calls[0].init?.headers).get("accesskey"), "account-key");

  await provider.setEncodeCompletionCallback(space, "https://callbacks.example.test/provider");
  assert.deepEqual(JSON.parse(String(stub.calls[2].init?.body)), {
    WebhookUrl: "https://callbacks.example.test/provider",
  });

  await assert.rejects(
    () => provider.deleteTenantSpace(space),
    (error: unknown) => {
      assert.ok(error instanceof BunnyApiError);
      assert.equal(error.definitiveRejection, false);
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    },
  );
  assert.ok((await provider.getPlaybackSources(space, { id: "asset-1" })).hlsUrl);
  await provider.deleteTenantSpace(space);
  await assert.rejects(
    () => provider.getPlaybackSources(space, { id: "asset-1" }),
    /credentials are unavailable/,
  );
  assert.equal(stub.remaining.length, 0);
}

async function testDefinitiveAndTransientErrors() {
  const rejectedSpace = createFetchStub([{ status: 400, body: { apiKey: "secret" } }]);
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: rejectedSpace.fetch,
    }).createTenantSpace({ name: "Tenant" }),
    (error: unknown) => {
      assert.ok(error instanceof TenantSpaceCreationRejectedError);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );

  const transientSpace = createFetchStub([{ status: 500 }]);
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: transientSpace.fetch,
    }).createTenantSpace({ name: "Tenant" }),
    (error: unknown) => error instanceof BunnyApiError && !error.definitiveRejection,
  );

  for (const [status, expectedClass] of [
    [422, AssetCreationRejectedError],
    [429, BunnyApiError],
    [503, BunnyApiError],
  ] as const) {
    const stub = createFetchStub([{ status }]);
    const provider = new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: stub.fetch,
      resolveLibraryCredentials: async () => credentials(),
    });
    await assert.rejects(
      () => provider.createAsset({ id: "123" }, { title: "Asset" }),
      (error: unknown) => error instanceof expectedClass,
    );
  }

  const rejectedCallback = createFetchStub([{ status: 422 }]);
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: rejectedCallback.fetch,
    }).setEncodeCompletionCallback(
      { id: "123" },
      "https://callbacks.example.test/provider",
    ),
    (error: unknown) => error instanceof EncodeCompletionCallbackRejectedError,
  );

  const ambiguousCallback = createFetchStub([{ status: 503 }]);
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: ambiguousCallback.fetch,
    }).setEncodeCompletionCallback(
      { id: "123" },
      "https://callbacks.example.test/provider",
    ),
    (error: unknown) => error instanceof BunnyApiError && !error.definitiveRejection,
  );
}

async function testTimeoutAndMalformedResponses() {
  const hangingFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: hangingFetch,
      requestTimeoutMs: 5,
    }).createTenantSpace({ name: "Tenant" }),
    /request failed/,
  );

  const malformedJson = (async () => new Response("{", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  await assert.rejects(
    () => new BunnyVideoProvider({
      accountApiKey: "account",
      fetch: malformedJson,
    }).createTenantSpace({ name: "Tenant" }),
    /returned invalid JSON/,
  );

  for (const invalidId of ["", " ", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const stub = createFetchStub([{
      status: 200,
      body: { Id: invalidId, PullZoneId: 456, ApiKey: "a", ReadOnlyApiKey: "b" },
    }]);
    await assert.rejects(
      () => new BunnyVideoProvider({
        accountApiKey: "account",
        fetch: stub.fetch,
      }).createTenantSpace({ name: "Tenant" }),
      /library Id was invalid/,
    );
  }
}

async function testCredentialIntegrityAndRotation() {
  const mismatch = new BunnyVideoProvider({
    accountApiKey: "account",
    resolveLibraryCredentials: async () => credentials({ libraryId: "999" }),
  });
  await assert.rejects(
    () => mismatch.getPlaybackSources({ id: "123" }, { id: "asset-1" }),
    /wrong library/,
  );

  let resolution = 0;
  const rotating = new BunnyVideoProvider({
    accountApiKey: "account",
    now: () => Date.UTC(2030, 0, 1),
    resolveLibraryCredentials: async () => credentials({
      pullZoneHostname: `tenant-${++resolution}.b-cdn.net`,
    }),
  });
  assert.match(
    (await rotating.getPlaybackSources({ id: "123" }, { id: "asset-1" })).hlsUrl!,
    /tenant-1\.b-cdn\.net/,
  );
  assert.match(
    (await rotating.getPlaybackSources({ id: "123" }, { id: "asset-1" })).hlsUrl!,
    /tenant-2\.b-cdn\.net/,
  );
  assert.equal(resolution, 2, "resolver-backed credentials must not become stale");

  const invalid = new BunnyVideoProvider({
    accountApiKey: "account",
    resolveLibraryCredentials: async () => credentials({ pullZoneHostname: "evil.example.com" }),
  });
  await assert.rejects(
    () => invalid.getPlaybackSources({ id: "123" }, { id: "asset-1" }),
    /pull-zone hostname was invalid/,
  );
}

async function testStatusUploadAndPlaybackValidation() {
  const stub = createFetchStub([
    { status: 200, body: { status: 3, length: 12.5 } },
    { status: 200, body: { status: 99, length: 0 } },
    { status: 200, body: { status: 3, length: Number.NaN } },
  ]);
  const provider = new BunnyVideoProvider({
    accountApiKey: "account",
    fetch: stub.fetch,
    now: () => Date.UTC(2030, 0, 1),
    resolveLibraryCredentials: async () => credentials(),
  });
  assert.deepEqual(await provider.getAssetStatus({ id: "123" }, { id: "asset-1" }), {
    state: "ready",
    durationSeconds: 12.5,
  });
  assert.deepEqual(await provider.getAssetStatus({ id: "123" }, { id: "asset-1" }), {
    state: "error",
    reason: "Bunny returned an unknown asset status",
  });
  await assert.rejects(
    () => provider.getAssetStatus({ id: "123" }, { id: "asset-1" }),
    /duration was invalid/,
  );

  for (const input of [
    { fileName: "", contentType: "video/mp4", contentLength: 1 },
    { fileName: "video.mp4", contentType: "text/html", contentLength: 1 },
    { fileName: "video.mp4", contentType: "video/mp4", contentLength: 0 },
  ]) {
    await assert.rejects(
      () => provider.getUploadCredentials({ id: "123" }, { id: "asset-1" }, input),
    );
  }
  const upload = await provider.getUploadCredentials(
    { id: "123" },
    { id: "asset-1" },
    { fileName: "video.mp4", contentType: "video/mp4", contentLength: 1 },
  );
  assert.equal(upload.kind, "tus");
  assert.equal(new URL(upload.endpoint).origin, "https://video.bunnycdn.com");

  const sources = await provider.getPlaybackSources({ id: "123" }, { id: "asset-1" });
  assert.equal(
    await provider.isPlaybackSourceTrusted({ id: "123" }, { id: "asset-1" }, sources.hlsUrl!),
    true,
  );
  for (const untrusted of [
    sources.hlsUrl!.replace("/asset-1/", "/asset-2/"),
    sources.hlsUrl!.replace("playlist.m3u8", "other.m3u8"),
    `${sources.hlsUrl!}?extra=1`,
    sources.hlsUrl!.replace(/expires=\d+/, "expires=1"),
    sources.hlsUrl!.replace("tenant-123.b-cdn.net", "evil.tenant-123.b-cdn.net"),
  ]) {
    assert.equal(
      await provider.isPlaybackSourceTrusted({ id: "123" }, { id: "asset-1" }, untrusted),
      false,
      `must reject untrusted playback URL: ${untrusted}`,
    );
  }
}

function testWebhookValidation() {
  const provider = new BunnyVideoProvider({
    accountApiKey: "account",
    webhookCredentials: credentials(),
  });
  const callback = signedCallback({
    body: { VideoLibraryId: 123, VideoGuid: "asset-1", Status: 3, Length: 12 },
  });
  assert.deepEqual(inspectBunnyEncodeCompletionCallback(callback.rawBody), { tenantSpaceId: "123" });
  const event = provider.verifyEncodeCompletionCallback(callback.rawBody, callback.headers);
  assert.equal(event?.tenantSpaceId, "123");
  assert.equal(event?.assetId, "asset-1");
  assert.deepEqual(event?.status, { state: "ready", durationSeconds: 12 });

  assert.equal(provider.verifyEncodeCompletionCallback(callback.rawBody, {
    ...callback.headers,
    "x-bunnystream-signature": ["a".repeat(64), callback.headers["x-bunnystream-signature"]],
  }), null);
  assert.equal(provider.verifyEncodeCompletionCallback(callback.rawBody, {
    ...callback.headers,
    "x-bunnystream-signature": "a".repeat(64),
  }), null);
  assert.equal(provider.verifyEncodeCompletionCallback(
    signedCallback({ body: { VideoLibraryId: 123, VideoGuid: " ", Status: 3 } }).rawBody,
    signedCallback({ body: { VideoLibraryId: 123, VideoGuid: " ", Status: 3 } }).headers,
  ), null);
  assert.equal(provider.verifyEncodeCompletionCallback(Buffer.alloc(64 * 1024 + 1), {}), null);
}

async function testCallbackUrlValidationAndNoInspectionNetwork() {
  let fetchCalls = 0;
  const provider = new BunnyVideoProvider({
    accountApiKey: "account",
    fetch: (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    webhookCredentials: credentials(),
  });
  assert.deepEqual(provider.availability, { state: "configured" });
  assert.equal(provider.capabilities.encodeCompletionCallback, true);
  assert.equal(fetchCalls, 0, "configuration inspection must not call Bunny");

  for (const url of [
    "http://callbacks.example.test/provider",
    "https://user:password@callbacks.example.test/provider",
    "https://127.0.0.1/provider",
    "https://localhost/provider",
    "not a URL",
  ]) {
    await assert.rejects(() => provider.setEncodeCompletionCallback({ id: "123" }, url));
  }
  assert.equal(fetchCalls, 0, "invalid callback URLs must fail before Bunny");
}

await testProvisioningAndCredentialRetention();
await testDefinitiveAndTransientErrors();
await testTimeoutAndMalformedResponses();
await testCredentialIntegrityAndRotation();
await testStatusUploadAndPlaybackValidation();
testWebhookValidation();
await testCallbackUrlValidationAndNoInspectionNetwork();
console.log("Bunny adapter conformance smoke passed");