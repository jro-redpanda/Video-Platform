import assert from "node:assert/strict";
import { Step7SmokeVideoProvider } from "@workspace/providers/test-only";

const { validatePlaybackSource } = await import(
  new URL("./lib/playback-sources.ts", import.meta.url).href
) as typeof import("./lib/playback-sources");

const provider = new Step7SmokeVideoProvider();
const space = { id: "security-smoke-space" };
const asset = { id: "security-smoke-asset" };

const valid = await provider.getPlaybackSources(space, asset);
const validated = await validatePlaybackSource(provider, space, asset, valid);
assert.match(validated.sourceUrl, /^https:\/\/playback\.test\.invalid\//);
assert.ok(validated.expiresAt.getTime() > Date.now() + 30_000);

for (const expiresAt of [
  "not-a-date",
  new Date(Date.now() + 10_000).toISOString(),
  new Date(Date.now() - 1_000).toISOString(),
]) {
  await assert.rejects(
    () => validatePlaybackSource(provider, space, asset, { ...valid, expiresAt }),
    /expired or near-expiry/,
  );
}

for (const hlsUrl of [
  "http://playback.test.invalid/master.m3u8",
  "https://user@playback.test.invalid/master.m3u8",
  "https://playback.test.invalid:444/master.m3u8",
  "https://playback.test.invalid/master.m3u8#fragment",
]) {
  await assert.rejects(
    () => validatePlaybackSource(provider, space, asset, { ...valid, hlsUrl }),
    /unsafe playback source URL/,
  );
}

await assert.rejects(
  () => validatePlaybackSource(provider, space, asset, {
    ...valid,
    hlsUrl: "https://playback.test.invalid.attacker.invalid/master.m3u8",
  }),
  /untrusted playback source/,
);

process.stdout.write("Playback source security smoke passed\n");