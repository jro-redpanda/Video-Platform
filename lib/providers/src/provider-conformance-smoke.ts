import assert from "node:assert/strict";
import { BunnyVideoProvider } from "./bunny/index.js";
import type { Asset, ProviderCapabilities } from "./contracts.js";
import { VideoProviderRegistry } from "./registry.js";
import { Step7SmokeVideoProvider } from "./test-only-fake.js";
import { PortableContractFixtureProvider } from "./portable-contract-fixture.js";
import { ProviderNotConfiguredError, UnconfiguredVideoProvider } from "./unconfigured.js";

const configuredCapabilities: ProviderCapabilities = {
  durableStorage: true,
  multiRenditionTranscoding: true,
  manifestFormats: ["hls"],
  cdnDelivery: true,
  uploadMethods: ["tus"],
  signedPlaybackUrls: true,
  encodeCompletionCallback: true,
};

const unavailableCapabilities: ProviderCapabilities = {
  durableStorage: false,
  multiRenditionTranscoding: false,
  manifestFormats: [],
  cdnDelivery: false,
  uploadMethods: [],
  signedPlaybackUrls: false,
  encodeCompletionCallback: false,
};

function assertCapabilities(
  actual: ProviderCapabilities,
  expected: ProviderCapabilities,
  provider: string,
) {
  assert.deepEqual(actual, expected, `${provider} feature declarations must be accurate`);
}

async function assertUnavailableMethods(provider: UnconfiguredVideoProvider) {
  const space = { id: "space" };
  const asset = { id: "asset" };
  const upload = { fileName: "video.mp4", contentType: "video/mp4", contentLength: 1 };
  const message = `Video provider "${provider.key}" is not configured`;

  const assertUnavailable = async (operation: () => Promise<unknown>) => {
    await assert.rejects(
      async () => operation(),
      (error: unknown) => {
        assert.ok(error instanceof ProviderNotConfiguredError);
        assert.equal(error.constructor, ProviderNotConfiguredError);
        assert.equal(error.name, "ProviderNotConfiguredError");
        assert.equal(error.message, message);
        return true;
      },
    );
  };

  await assertUnavailable(() => provider.createTenantSpace({ name: "space" }));
  await assertUnavailable(() => provider.setEncodeCompletionCallback(
    space,
    "https://callbacks.example.test/provider",
  ));
  await assertUnavailable(() => provider.deleteTenantSpace(space));
  await assertUnavailable(() => provider.createAsset(space, { title: "asset" }));
  await assertUnavailable(() => provider.getUploadCredentials(space, asset, upload));
  await assertUnavailable(() => provider.getAssetStatus(space, asset));
  await assertUnavailable(() => provider.deleteAsset(space, asset));
  await assertUnavailable(() => provider.getPlaybackSources(space, asset));
  assert.throws(
    () => provider.verifyEncodeCompletionCallback(Buffer.from("{}"), {}),
    (error: unknown) => {
      assert.ok(error instanceof ProviderNotConfiguredError);
      assert.equal(error.constructor, ProviderNotConfiguredError);
      assert.equal(error.name, "ProviderNotConfiguredError");
      assert.equal(error.message, message);
      return true;
    },
  );
  assert.equal(
    await provider.isPlaybackSourceTrusted(space, asset, "https://playback.test.invalid/master.m3u8"),
    false,
  );
}

async function assertPlaybackTrust(provider: {
  isPlaybackSourceTrusted(space: { id: string }, asset: Asset, url: string): Promise<boolean>;
}, space: { id: string }, asset: Asset, validUrl: string) {
  assert.equal(
    await provider.isPlaybackSourceTrusted(space, asset, validUrl),
    true,
    "trusted playback URL is accepted",
  );
  const explicitPortUrl = new URL(validUrl);
  explicitPortUrl.port = "444";
  for (const url of [
    validUrl.replace("https://", "http://"),
    validUrl.replace("https://", "https://user:password@"),
    explicitPortUrl.toString(),
    validUrl.replace("https://", "https://evil."),
    `${validUrl}#fragment`,
    "not a URL",
  ]) {
    assert.equal(
      await provider.isPlaybackSourceTrusted(space, asset, url),
      false,
      `untrusted playback URL is rejected: ${url}`,
    );
  }
}

async function main() {
  // Construction is intentionally the only Bunny interaction in this smoke.
  const bunny = new BunnyVideoProvider({ accountApiKey: "syntactically-nonempty-fake-key" });
  const smoke = new Step7SmokeVideoProvider();
  const portable = new PortableContractFixtureProvider();
  const bunnyTrust = new BunnyVideoProvider({
    accountApiKey: "syntactically-nonempty-fake-key",
    resolveLibraryCredentials: async () => ({
      libraryId: "123",
      apiKey: "fake",
      readOnlyApiKey: "fake",
      pullZoneId: "456",
      pullZoneHostname: "tenant-123.b-cdn.net",
      zoneSecurityKey: "fake",
      zoneSecurityEnabled: true,
    }),
    now: () => Date.UTC(2030, 0, 1),
  });
  const unconfigured = new UnconfiguredVideoProvider("not-configured");
  const registry = new VideoProviderRegistry();
  const fallback = registry.resolve("unknown-provider");

  assert.equal(bunny.key, "bunny");
  assert.deepEqual(bunny.availability, { state: "configured" });
  assertCapabilities(bunny.capabilities, configuredCapabilities, "Bunny");

  assert.equal(smoke.key, "step7-smoke");
  assert.deepEqual(smoke.availability, { state: "configured" });
  assertCapabilities(smoke.capabilities, configuredCapabilities, "Step7 smoke");
  const smokeSpace = await smoke.createTenantSpace({ name: "conformance" });
  await smoke.setEncodeCompletionCallback(smokeSpace, "https://callbacks.example.test/provider");
  const smokeAsset = await smoke.createAsset(smokeSpace, { title: "conformance" });
  const smokeSources = await smoke.getPlaybackSources(smokeSpace, smokeAsset);
  await assertPlaybackTrust(
    smoke,
    smokeSpace,
    smokeAsset,
    smokeSources.hlsUrl!,
  );
  const callback = smoke.createEncodeCompletionCallback({
    eventId: "event-1",
    tenantSpaceId: smokeSpace.id,
    assetId: smokeAsset.id,
    state: "ready",
    durationSeconds: 12,
  });
  assert.deepEqual(smoke.verifyEncodeCompletionCallback(callback.rawBody, callback.headers)?.status, {
    state: "ready",
    durationSeconds: 12,
  });
  assert.deepEqual(await smoke.getAssetStatus(smokeSpace, smokeAsset), {
    state: "ready",
    durationSeconds: 12,
  });

  assert.deepEqual(portable.capabilities, {
    durableStorage: true,
    multiRenditionTranscoding: false,
    manifestFormats: ["dash"],
    cdnDelivery: true,
    uploadMethods: ["multipart"],
    signedPlaybackUrls: false,
    encodeCompletionCallback: true,
  });
  const portableSpace = await portable.createTenantSpace({ name: "portable conformance" });
  await portable.setEncodeCompletionCallback(
    portableSpace,
    "https://callbacks.example.test/portable",
  );
  const portableAsset = await portable.createAsset(portableSpace, { title: "portable asset" });
  const multipart = await portable.getUploadCredentials(portableSpace, portableAsset, {
    fileName: "portable.mov",
    contentType: "video/quicktime",
    contentLength: 1024,
  });
  assert.equal(multipart.kind, "multipart");
  assert.equal(multipart.parts[0]?.number, 1);
  const portableSources = await portable.getPlaybackSources(portableSpace, portableAsset);
  assert.ok(portableSources.dashUrl);
  assert.equal(portableSources.hlsUrl, undefined);
  assert.equal(
    await portable.isPlaybackSourceTrusted(portableSpace, portableAsset, portableSources.dashUrl!),
    true,
  );
  assert.equal(
    await portable.isPlaybackSourceTrusted(
      portableSpace,
      { id: "other-asset" },
      portableSources.dashUrl!,
    ),
    false,
  );
  const portableCallback = portable.createEncodeCompletionCallback({
    eventId: "portable-event",
    tenantSpaceId: portableSpace.id,
    assetId: portableAsset.id,
    durationSeconds: 42,
  });
  assert.deepEqual(
    portable.verifyEncodeCompletionCallback(
      portableCallback.rawBody,
      portableCallback.headers,
    )?.status,
    { state: "ready", durationSeconds: 42 },
  );

  const bunnySpace = { id: "123" };
  const bunnyAsset = { id: "asset-123" };
  const bunnySources = await bunnyTrust.getPlaybackSources(bunnySpace, bunnyAsset);
  await assertPlaybackTrust(
    bunnyTrust,
    bunnySpace,
    bunnyAsset,
    bunnySources.hlsUrl!.replace("tenant-123", "TENANT-123"),
  );
  assert.equal(
    await bunnyTrust.isPlaybackSourceTrusted(
      bunnySpace,
      { id: "different-asset" },
      bunnySources.hlsUrl!,
    ),
    false,
    "Bunny playback trust is bound to the expected asset",
  );

  assert.equal(unconfigured.key, "not-configured");
  assert.deepEqual(unconfigured.availability, { state: "unavailable", reason: "not_configured" });
  assertCapabilities(unconfigured.capabilities, unavailableCapabilities, "unconfigured");
  await assertUnavailableMethods(unconfigured);

  assert.equal(fallback.key, "unknown-provider");
  assert.deepEqual(fallback.availability, { state: "unavailable", reason: "not_configured" });
  assertCapabilities(fallback.capabilities, unavailableCapabilities, "registry fallback");
  assert.ok(fallback instanceof UnconfiguredVideoProvider);
  assert.equal(registry.resolve("unknown-provider"), fallback, "registry fallbacks are stable per key");
  assert.throws(() => registry.resolve(""), /lowercase identifier/);
  assert.throws(() => registry.resolve("BUNNY"), /lowercase identifier/);
  registry.register(smoke);
  assert.throws(() => registry.register(smoke), /already registered/);
  await assertUnavailableMethods(fallback);
}

await main();
console.log("Provider adapter conformance smoke passed");