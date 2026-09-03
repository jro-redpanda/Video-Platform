import type { Asset, AssetStatus, EncodeCompletionEvent, PlaybackSources, ProviderCapabilities, TenantSpace, UploadCredentials, VideoProvider } from "./contracts.js";
import { createHmac } from "node:crypto";

/** TEST-ONLY: deterministic provider for automated tests. Never register in production. */
export class Step7SmokeVideoProvider implements VideoProvider {
  readonly key = "step7-smoke";
  readonly availability = { state: "configured" } as const;
  readonly capabilities: ProviderCapabilities = {
    durableStorage: true, multiRenditionTranscoding: true, manifestFormats: ["hls"],
    cdnDelivery: true, uploadMethods: ["tus"], signedPlaybackUrls: true, encodeCompletionCallback: true,
  };
  private readonly spaces = new Map<string, TenantSpace>();
  private readonly assetStatuses = new Map<string, AssetStatus>();
  private readonly callbackUrls = new Map<string, string>();
  createAssetCalls = 0;
  deleteAssetCalls = 0;
  callbackConfigurationCalls = 0;
  failNextDeleteAfterAcceptance = false;
  failNextCallbackConfiguration = false;
  lastConfiguredCallbackUrl: string | undefined;
  /** Test hook for route-level playback-origin rejection coverage. */
  playbackUrlOverride: string | undefined;

  async createTenantSpace(input: { name: string }): Promise<TenantSpace> {
    const idempotencyKey = input.name;
    const existing = this.spaces.get(idempotencyKey);
    if (existing) return existing;
    const space = { id: `smoke-space-${idempotencyKey}` };
    this.spaces.set(idempotencyKey, space);
    return space;
  }
  async setEncodeCompletionCallback(space: TenantSpace, webhookUrl: string): Promise<void> {
    this.callbackConfigurationCalls += 1;
    if (this.failNextCallbackConfiguration) {
      this.failNextCallbackConfiguration = false;
      throw new Error("Test-only ambiguous callback configuration outcome");
    }
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("Test callback URL must be a safe HTTPS URL");
    }
    this.callbackUrls.set(space.id, url.toString());
    this.lastConfiguredCallbackUrl = url.toString();
  }
  async deleteTenantSpace(space: TenantSpace) {
    this.spaces.delete(space.id);
    this.callbackUrls.delete(space.id);
  }
  async createAsset(space: TenantSpace, input: { title: string }): Promise<Asset> {
    this.createAssetCalls += 1;
    const asset = { id: `test-asset-${this.createAssetCalls}-${stable(input.title)}-${stable(space.id)}` };
    this.assetStatuses.set(asset.id, { state: "created" });
    return asset;
  }
  async getUploadCredentials(_space: TenantSpace, asset: Asset, _input: { fileName: string; contentType: string; contentLength: number }): Promise<UploadCredentials> {
    return {
      kind: "tus",
      endpoint: "https://uploads.test.invalid/tus",
      headers: { "X-Upload-Authorization": `test-${stable(asset.id)}` },
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
  }
  async getAssetStatus(_space: TenantSpace, asset: Asset): Promise<AssetStatus> {
    return this.assetStatuses.get(asset.id) ?? { state: "error", reason: "Test asset not found" };
  }
  async deleteAsset(_space: TenantSpace, _asset: Asset) {
    this.deleteAssetCalls += 1;
    if (this.failNextDeleteAfterAcceptance) {
      this.failNextDeleteAfterAcceptance = false;
      throw new Error("Test-only ambiguous deletion outcome");
    }
    this.assetStatuses.delete(_asset.id);
  }
  async getPlaybackSources(_space: TenantSpace, asset: Asset): Promise<PlaybackSources> {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      hlsUrl: this.playbackUrlOverride ?? `https://playback.test.invalid/${stable(asset.id)}/master.m3u8?expires=${encodeURIComponent(expiresAt)}`,
      posterUrl: `https://playback.test.invalid/${stable(asset.id)}/poster.jpg?expires=${encodeURIComponent(expiresAt)}`,
      expiresAt,
    };
  }
  async isPlaybackSourceTrusted(_space: TenantSpace, asset: Asset, value: string): Promise<boolean> {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && !url.username
        && !url.password
        && !url.port
        && !url.hash
        && url.hostname === "playback.test.invalid"
        && url.pathname.startsWith(`/${encodeURIComponent(stable(asset.id))}/`);
    } catch {
      return false;
    }
  }
  verifyEncodeCompletionCallback(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    if (singleHeader(headers, "x-test-signature") !== createHmac("sha256", "step7-smoke-callback")
      .update(rawBody).digest("hex")) return null;
    let value: unknown;
    try {
      value = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(value) || typeof value.eventId !== "string" || typeof value.tenantSpaceId !== "string"
      || typeof value.assetId !== "string" || (value.state !== "ready" && value.state !== "error")) return null;
    const status: EncodeCompletionEvent["status"] = value.state === "ready"
      ? { state: "ready", durationSeconds: typeof value.durationSeconds === "number" ? value.durationSeconds : 0 }
      : { state: "error", reason: typeof value.reason === "string" ? value.reason : "Test encoding failed" };
    this.assetStatuses.set(value.assetId, status);
    return {
      eventId: value.eventId,
      tenantSpaceId: value.tenantSpaceId,
      assetId: value.assetId,
      status,
      occurredAt: new Date(0).toISOString(),
    };
  }

  /** Test hook for creating a deterministic callback accepted by this fake. */
  createEncodeCompletionCallback(input: {
    eventId: string;
    tenantSpaceId: string;
    assetId: string;
    state: "ready" | "error";
    durationSeconds?: number;
    reason?: string;
  }) {
    const rawBody = Buffer.from(JSON.stringify(input));
    return {
      rawBody,
      headers: {
        "x-test-signature": createHmac("sha256", "step7-smoke-callback").update(rawBody).digest("hex"),
      },
    };
  }
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

function singleHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || Array.isArray(value)) continue;
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}