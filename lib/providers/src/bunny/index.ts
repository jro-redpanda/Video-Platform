import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  Asset,
  AssetStatus,
  EncodeCompletionEvent,
  PlaybackSources,
  ProviderCapabilities,
  TenantSpace,
  UploadCredentials,
  VideoProvider,
} from "../contracts";

const CORE_API = "https://api.bunny.net";
const STREAM_API = "https://video.bunnycdn.com";

export type BunnyLibraryCredentials = {
  libraryId: string;
  apiKey: string;
  readOnlyApiKey: string;
  pullZoneId: string;
  pullZoneHostname: string;
  zoneSecurityKey: string;
  zoneSecurityEnabled: boolean;
};

type BunnyProviderOptions = {
  accountApiKey: string;
  resolveLibraryCredentials?: (libraryId: string) => Promise<BunnyLibraryCredentials>;
};

type BunnyWebhookBody = {
  VideoLibraryId: number;
  VideoGuid: string;
  Status: number;
};

export class BunnyVideoProvider implements VideoProvider {
  readonly key = "bunny";
  readonly capabilities: ProviderCapabilities = {
    durableStorage: true,
    multiRenditionTranscoding: true,
    manifestFormats: ["hls"],
    cdnDelivery: true,
    uploadMethods: ["tus"],
    signedPlaybackUrls: true,
    encodeCompletionCallback: true,
  };

  private readonly libraries = new Map<string, BunnyLibraryCredentials>();
  private readonly accountApiKey: string;

  constructor(private readonly options: BunnyProviderOptions) {
    this.accountApiKey = options.accountApiKey.trim();
    if (!this.accountApiKey) throw new Error("Bunny account API key is required");
  }

  async createTenantSpace(input: { name: string }): Promise<TenantSpace> {
    const library = await this.coreRequest<Record<string, unknown>>("/videolibrary", {
      method: "POST",
      body: JSON.stringify({ Name: input.name, AllowDirectPlay: true }),
    });
    const libraryId = requiredString(library.Id, "Bunny library Id");
    const pullZoneId = requiredString(library.PullZoneId, "Bunny PullZoneId");
    const pullZone = await this.coreRequest<Record<string, unknown>>(`/pullzone/${pullZoneId}`);
    const hostnames = Array.isArray(pullZone.Hostnames) ? pullZone.Hostnames : [];
    const hostname = hostnames
      .map((entry) => isRecord(entry) ? entry.Value : undefined)
      .find((value): value is string => typeof value === "string" && value.endsWith(".b-cdn.net"));

    const credentials: BunnyLibraryCredentials = {
      libraryId,
      apiKey: requiredString(library.ApiKey, "Bunny library ApiKey"),
      readOnlyApiKey: requiredString(library.ReadOnlyApiKey, "Bunny library ReadOnlyApiKey"),
      pullZoneId,
      pullZoneHostname: requiredString(hostname, "Bunny pull-zone hostname"),
      zoneSecurityKey: requiredString(pullZone.ZoneSecurityKey, "Bunny ZoneSecurityKey"),
      zoneSecurityEnabled: pullZone.ZoneSecurityEnabled === true,
    };
    this.libraries.set(libraryId, credentials);
    return { id: libraryId };
  }

  async setEncodeCompletionCallback(space: TenantSpace, webhookUrl: string): Promise<void> {
    await this.coreRequest(`/videolibrary/${encodeURIComponent(space.id)}`, {
      method: "POST",
      body: JSON.stringify({ WebhookUrl: webhookUrl }),
    });
  }

  async getLibraryCredentials(space: TenantSpace): Promise<BunnyLibraryCredentials> {
    return this.credentials(space.id);
  }

  async deleteTenantSpace(space: TenantSpace): Promise<void> {
    try {
      await this.coreRequest(`/videolibrary/${encodeURIComponent(space.id)}`, { method: "DELETE" });
    } finally {
      this.libraries.delete(space.id);
    }
  }

  async createAsset(space: TenantSpace, input: { title: string }): Promise<Asset> {
    const credentials = await this.credentials(space.id);
    const response = await this.streamRequest<Record<string, unknown>>(
      credentials,
      `/library/${space.id}/videos`,
      { method: "POST", body: JSON.stringify({ title: input.title }) },
    );
    return { id: requiredString(response.guid, "Bunny video guid") };
  }

  async getUploadCredentials(
    space: TenantSpace,
    asset: Asset,
    _input: { fileName: string; contentType: string; contentLength: number },
  ): Promise<UploadCredentials> {
    const credentials = await this.credentials(space.id);
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = createHash("sha256")
      .update(`${space.id}${credentials.apiKey}${expiration}${asset.id}`)
      .digest("hex");
    return {
      kind: "tus",
      endpoint: `${STREAM_API}/tusupload`,
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expiration),
        LibraryId: space.id,
        VideoId: asset.id,
      },
      expiresAt: new Date(expiration * 1000).toISOString(),
    };
  }

  async getAssetStatus(space: TenantSpace, asset: Asset): Promise<AssetStatus> {
    const credentials = await this.credentials(space.id);
    const video = await this.streamRequest<Record<string, unknown>>(
      credentials,
      `/library/${space.id}/videos/${asset.id}`,
    );
    const status = Number(video.status);
    if (status === 3) return { state: "ready", durationSeconds: Number(video.length ?? 0) };
    if (status === 5 || status === 8) return { state: "error", reason: `Bunny status ${status}` };
    if (status === 0) return { state: "created" };
    if (status === 6) return { state: "uploading" };
    return { state: "processing" };
  }

  async deleteAsset(space: TenantSpace, asset: Asset): Promise<void> {
    const credentials = await this.credentials(space.id);
    await this.streamRequest(credentials, `/library/${space.id}/videos/${asset.id}`, { method: "DELETE" });
  }

  async getPlaybackSources(space: TenantSpace, asset: Asset): Promise<PlaybackSources> {
    const credentials = await this.credentials(space.id);
    if (!credentials.zoneSecurityEnabled) {
      throw new Error(`Bunny CDN token authentication is not enabled for library ${space.id}`);
    }
    const expires = Math.floor(Date.now() / 1000) + 15 * 60;
    const directory = `/${asset.id}/`;
    const signature = createHmac("sha256", credentials.zoneSecurityKey)
      .update(`${directory}${expires}`)
      .digest("base64url");
    const token = `HS256-${signature}`;
    const root = `https://${credentials.pullZoneHostname}/bcdn_token=${token}&expires=${expires}`;
    return {
      hlsUrl: `${root}${directory}playlist.m3u8`,
      posterUrl: `${root}${directory}thumbnail.jpg`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  verifyEncodeCompletionCallback(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    if (header(headers, "x-bunnystream-signature-version") !== "v1") return null;
    if (header(headers, "x-bunnystream-signature-algorithm") !== "hmac-sha256") return null;
    const signature = header(headers, "x-bunnystream-signature");
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return null;

    const payload = parseWebhook(rawBody);
    const credentials = this.libraries.get(String(payload.VideoLibraryId));
    if (!credentials) return null;
    const expected = createHmac("sha256", credentials.readOnlyApiKey).update(rawBody).digest();
    const provided = Buffer.from(signature, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    if (payload.Status !== 3 && payload.Status !== 5 && payload.Status !== 8) return null;

    return {
      eventId: createHash("sha256").update(rawBody).digest("hex"),
      tenantSpaceId: String(payload.VideoLibraryId),
      assetId: payload.VideoGuid,
      status: payload.Status === 3
        ? { state: "ready", durationSeconds: 0 }
        : { state: "error", reason: `Bunny status ${payload.Status}` },
      occurredAt: new Date().toISOString(),
    };
  }

  private async credentials(libraryId: string) {
    const cached = this.libraries.get(libraryId);
    if (cached) return cached;
    if (!this.options.resolveLibraryCredentials) {
      throw new Error(`Bunny credentials are unavailable for library ${libraryId}`);
    }
    const resolved = await this.options.resolveLibraryCredentials(libraryId);
    this.libraries.set(libraryId, resolved);
    return resolved;
  }

  private coreRequest<T = unknown>(path: string, init: RequestInit = {}) {
    return request<T>(`${CORE_API}${path}`, this.accountApiKey, init);
  }

  private streamRequest<T = unknown>(
    credentials: BunnyLibraryCredentials,
    path: string,
    init: RequestInit = {},
  ) {
    return request<T>(`${STREAM_API}${path}`, credentials.apiKey, init);
  }
}

async function request<T>(url: string, accessKey: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { AccessKey: accessKey, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Bunny API ${init.method ?? "GET"} ${new URL(url).pathname} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
  return response.json() as Promise<T>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  throw new Error(`${label} was missing from the Bunny response`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWebhook(rawBody: Buffer): BunnyWebhookBody {
  const value: unknown = JSON.parse(rawBody.toString("utf8"));
  if (!isRecord(value)) throw new Error("Invalid Bunny webhook body");
  const libraryId = Number(value.VideoLibraryId);
  const status = Number(value.Status);
  if (!Number.isInteger(libraryId) || typeof value.VideoGuid !== "string" || !Number.isInteger(status)) {
    throw new Error("Invalid Bunny webhook fields");
  }
  return { VideoLibraryId: libraryId, VideoGuid: value.VideoGuid, Status: status };
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}