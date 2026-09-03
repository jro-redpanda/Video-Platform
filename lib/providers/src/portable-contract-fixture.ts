import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Asset,
  AssetStatus,
  EncodeCompletionEvent,
  PlaybackSources,
  ProviderCapabilities,
  TenantSpace,
  UploadCredentials,
  VideoProvider,
} from "./contracts.js";

/**
 * TEST-ONLY provider-independent fixture. It deliberately uses DASH and
 * multipart upload so conformance coverage cannot assume Bunny's HLS/TUS shape.
 */
export class PortableContractFixtureProvider implements VideoProvider {
  readonly key = "portable-fixture";
  readonly availability = { state: "configured" } as const;
  readonly capabilities: ProviderCapabilities = {
    durableStorage: true,
    multiRenditionTranscoding: false,
    manifestFormats: ["dash"],
    cdnDelivery: true,
    uploadMethods: ["multipart"],
    signedPlaybackUrls: false,
    encodeCompletionCallback: true,
  };

  private readonly assets = new Map<string, AssetStatus>();
  private readonly callbackUrls = new Map<string, string>();

  async createTenantSpace(input: { name: string }): Promise<TenantSpace> {
    if (!input.name.trim()) throw new Error("Fixture tenant-space name is required");
    return { id: `fixture:${stable(input.name)}` };
  }

  async setEncodeCompletionCallback(space: TenantSpace, webhookUrl: string): Promise<void> {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("Fixture callback URL must be safe HTTPS");
    }
    this.callbackUrls.set(space.id, url.toString());
  }

  async deleteTenantSpace(space: TenantSpace): Promise<void> {
    this.callbackUrls.delete(space.id);
  }

  async createAsset(space: TenantSpace, input: { title: string }): Promise<Asset> {
    const asset = { id: `fixture:${stable(space.id)}:${stable(input.title)}` };
    this.assets.set(asset.id, { state: "created" });
    return asset;
  }

  async getUploadCredentials(
    _space: TenantSpace,
    asset: Asset,
    input: { fileName: string; contentType: string; contentLength: number },
  ): Promise<UploadCredentials> {
    if (!input.fileName || !input.contentType || input.contentLength <= 0) {
      throw new Error("Fixture upload input is invalid");
    }
    this.assets.set(asset.id, { state: "uploading" });
    return {
      kind: "multipart",
      uploadId: `fixture-upload:${stable(asset.id)}`,
      partSizeBytes: 5 * 1024 * 1024,
      parts: [{
        number: 1,
        url: `https://multipart.fixture.invalid/assets/${encodeURIComponent(asset.id)}/parts/1`,
        headers: { "x-fixture-part": "1" },
      }],
      completeUrl: `https://multipart.fixture.invalid/assets/${encodeURIComponent(asset.id)}/complete`,
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
  }

  async getAssetStatus(_space: TenantSpace, asset: Asset): Promise<AssetStatus> {
    return this.assets.get(asset.id) ?? { state: "error", reason: "Fixture asset not found" };
  }

  async deleteAsset(_space: TenantSpace, asset: Asset): Promise<void> {
    this.assets.delete(asset.id);
  }

  async getPlaybackSources(_space: TenantSpace, asset: Asset): Promise<PlaybackSources> {
    return {
      dashUrl: `https://playback.fixture.invalid/assets/${encodeURIComponent(asset.id)}/manifest.mpd`,
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
  }

  async isPlaybackSourceTrusted(_space: TenantSpace, asset: Asset, value: string): Promise<boolean> {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port
        && !url.hash && !url.search && url.hostname === "playback.fixture.invalid"
        && url.pathname === `/assets/${encodeURIComponent(asset.id)}/manifest.mpd`;
    } catch {
      return false;
    }
  }

  verifyEncodeCompletionCallback(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    const signature = headers["x-fixture-signature"];
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const expected = createHmac("sha256", "portable-contract-fixture").update(rawBody).digest();
    const provided = Buffer.from(signature, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    let value: unknown;
    try {
      value = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(value) || typeof value.eventId !== "string"
      || typeof value.tenantSpaceId !== "string" || typeof value.assetId !== "string"
      || value.state !== "ready" || typeof value.durationSeconds !== "number") return null;
    const status = { state: "ready", durationSeconds: value.durationSeconds } as const;
    this.assets.set(value.assetId, status);
    return {
      eventId: value.eventId,
      tenantSpaceId: value.tenantSpaceId,
      assetId: value.assetId,
      status,
      occurredAt: new Date(0).toISOString(),
    };
  }

  createEncodeCompletionCallback(input: {
    eventId: string;
    tenantSpaceId: string;
    assetId: string;
    durationSeconds: number;
  }) {
    const rawBody = Buffer.from(JSON.stringify({ ...input, state: "ready" }));
    return {
      rawBody,
      headers: {
        "x-fixture-signature": createHmac("sha256", "portable-contract-fixture")
          .update(rawBody).digest("hex"),
      },
    };
  }
}

function stable(value: string): string {
  return createHmac("sha256", "portable-contract-fixture").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}