import assert from "node:assert/strict";
import { BunnyVideoProvider } from "./bunny/index.js";
import type { ProviderCapabilities } from "./contracts.js";
import { VideoProviderRegistry } from "./registry.js";
import { Step7SmokeVideoProvider } from "./test-only-fake.js";
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
  assert.equal(await provider.isPlaybackSourceTrusted(space, "https://playback.test.invalid/master.m3u8"), false);
}

async function assertPlaybackTrust(provider: {
  isPlaybackSourceTrusted(space: { id: string }, url: string): Promise<boolean>;
}, space: { id: string }, validUrl: string) {
  assert.equal(await provider.isPlaybackSourceTrusted(space, validUrl), true, "trusted playback URL is accepted");
  for (const url of [
    validUrl.replace("https://", "http://"),
    validUrl.replace("https://", "https://user:password@"),
    validUrl.replace(/\/master\.m3u8/, ":444/master.m3u8"),
    validUrl.replace("https://", "https://evil."),
    "not a URL",
  ]) {
    assert.equal(await provider.isPlaybackSourceTrusted(space, url), false, `untrusted playback URL is rejected: ${url}`);
  }
}

async function main() {
  // Construction is intentionally the only Bunny interaction in this smoke.
  const bunny = new BunnyVideoProvider({ accountApiKey: "syntactically-nonempty-fake-key" });
  const smoke = new Step7SmokeVideoProvider();
  const bunnyTrust = new BunnyVideoProvider({
    accountApiKey: "syntactically-nonempty-fake-key",
    resolveLibraryCredentials: async () => ({
      libraryId: "trust-space",
      apiKey: "fake",
      readOnlyApiKey: "fake",
      pullZoneId: "fake",
      pullZoneHostname: "tenant-123.b-cdn.net",
      zoneSecurityKey: "fake",
      zoneSecurityEnabled: true,
    }),
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
  await assertPlaybackTrust(
    smoke,
    { id: "smoke-space" },
    "https://playback.test.invalid/master.m3u8?token=fake",
  );
  await assertPlaybackTrust(
    bunnyTrust,
    { id: "trust-space" },
    "https://TENANT-123.B-CDN.NET/master.m3u8?token=fake",
  );
  assert.equal(
    await bunnyTrust.isPlaybackSourceTrusted(
      { id: "trust-space" },
      "https://tenant-123.b-cdn.net/master.m3u8#fragment",
    ),
    false,
    "Bunny playback fragments are rejected",
  );

  assert.equal(unconfigured.key, "not-configured");
  assert.deepEqual(unconfigured.availability, { state: "unavailable", reason: "not_configured" });
  assertCapabilities(unconfigured.capabilities, unavailableCapabilities, "unconfigured");
  await assertUnavailableMethods(unconfigured);

  assert.equal(fallback.key, "unknown-provider");
  assert.deepEqual(fallback.availability, { state: "unavailable", reason: "not_configured" });
  assertCapabilities(fallback.capabilities, unavailableCapabilities, "registry fallback");
  assert.ok(fallback instanceof UnconfiguredVideoProvider);
  await assertUnavailableMethods(fallback);
}

await main();
console.log("Provider adapter conformance smoke passed");