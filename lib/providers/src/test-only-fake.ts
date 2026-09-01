import type { Asset, AssetStatus, EncodeCompletionEvent, PlaybackSources, ProviderCapabilities, TenantSpace, UploadCredentials, VideoProvider } from "./contracts";
import { createHmac } from "node:crypto";

/** TEST-ONLY: deterministic provider for automated tests. Never register in production. */
export class Step7SmokeVideoProvider implements VideoProvider {
  readonly key = "step7-smoke";
  readonly capabilities: ProviderCapabilities = {
    durableStorage: true, multiRenditionTranscoding: true, manifestFormats: ["hls"],
    cdnDelivery: true, uploadMethods: ["tus"], signedPlaybackUrls: true, encodeCompletionCallback: true,
  };
  private readonly spaces = new Map<string, TenantSpace>();
  createAssetCalls = 0;
  deleteAssetCalls = 0;

  async createTenantSpace(input: { name: string }): Promise<TenantSpace> {
    const idempotencyKey = input.name;
    const existing = this.spaces.get(idempotencyKey);
    if (existing) return existing;
    const space = { id: `smoke-space-${idempotencyKey}` };
    this.spaces.set(idempotencyKey, space);
    return space;
  }
  async deleteTenantSpace(_space: TenantSpace) {}
  async createAsset(space: TenantSpace, input: { title: string }): Promise<Asset> {
    this.createAssetCalls += 1;
    return { id: `test-asset-${this.createAssetCalls}-${stable(input.title)}-${stable(space.id)}` };
  }
  async getUploadCredentials(_space: TenantSpace, asset: Asset, _input: { fileName: string; contentType: string; contentLength: number }): Promise<UploadCredentials> {
    return {
      kind: "tus",
      endpoint: "https://uploads.test.invalid/tus",
      headers: { "X-Upload-Authorization": `test-${stable(asset.id)}` },
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
  }
  async getAssetStatus(_space: TenantSpace, _asset: Asset): Promise<AssetStatus> { throw new Error("Test-only provider does not simulate status polling"); }
  async deleteAsset(_space: TenantSpace, _asset: Asset) { this.deleteAssetCalls += 1; }
  async getPlaybackSources(_space: TenantSpace, asset: Asset): Promise<PlaybackSources> {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      hlsUrl: `https://playback.test.invalid/${stable(asset.id)}/master.m3u8?expires=${encodeURIComponent(expiresAt)}`,
      posterUrl: `https://playback.test.invalid/${stable(asset.id)}/poster.jpg?expires=${encodeURIComponent(expiresAt)}`,
      expiresAt,
    };
  }
  verifyEncodeCompletionCallback(_rawBody: Buffer, _headers: Readonly<Record<string, string | string[] | undefined>>): EncodeCompletionEvent | null { return null; }
}

/** TEST-ONLY signed Bunny fixture. Production code has no deterministic-signing fallback. */
export function createStep10BunnyCallback(input: {
  libraryId: number;
  assetId: string;
  status: 3 | 5 | 8;
  readOnlyApiKey: string;
  durationSeconds?: number;
}) {
  const rawBody = Buffer.from(JSON.stringify({
    VideoLibraryId: input.libraryId,
    VideoGuid: input.assetId,
    Status: input.status,
    ...(input.durationSeconds === undefined ? {} : { Length: input.durationSeconds }),
  }));
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-bunnystream-signature-version": "v1",
      "x-bunnystream-signature-algorithm": "hmac-sha256",
      "x-bunnystream-signature": createHmac("sha256", input.readOnlyApiKey).update(rawBody).digest("hex"),
    },
  };
}

function stable(value: string) {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}