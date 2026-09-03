import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  AssetCreationRejectedError,
  EncodeCompletionCallbackRejectedError,
  TenantSpaceCreationRejectedError,
} from "../contracts.js";
import type {
  Asset,
  AssetStatus,
  EncodeCompletionEvent,
  PlaybackSources,
  ProviderCapabilities,
  TenantSpace,
  UploadCredentials,
  VideoProvider,
} from "../contracts.js";

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
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  now?: () => number;
  resolveLibraryCredentials?: (libraryId: string) => Promise<BunnyLibraryCredentials>;
  /** Pre-resolved private credentials used for synchronous callback verification. */
  webhookCredentials?: BunnyLibraryCredentials;
  /** Bunny-internal persistence hook. It must complete before the space is returned. */
  onLibraryCreated?: (library: BunnyLibraryCredentials) => Promise<void>;
};

type BunnyWebhookBody = {
  VideoLibraryId: number;
  VideoGuid: string;
  Status: number;
  Length?: number;
};

export class BunnyApiError extends Error {
  readonly definitiveRejection: boolean;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`Bunny API ${method} ${path} failed (${status})`);
    this.name = "BunnyApiError";
    this.definitiveRejection = status >= 400 && status < 500
      && status !== 408 && status !== 409 && status !== 425 && status !== 429;
  }
}

export class BunnyVideoProvider implements VideoProvider {
  readonly key = "bunny";
  readonly availability = { state: "configured" } as const;
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
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BunnyProviderOptions) {
    this.accountApiKey = options.accountApiKey.trim();
    if (!this.accountApiKey) throw new Error("Bunny account API key is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Bunny request timeout must be a positive integer");
    }
    this.now = options.now ?? Date.now;
    if (options.webhookCredentials) {
      const credentials = validateLibraryCredentials(options.webhookCredentials);
      this.libraries.set(credentials.libraryId, credentials);
    }
  }

  async createTenantSpace(input: { name: string }): Promise<TenantSpace> {
    const name = requiredInputString(input.name, "Tenant-space name");
    let library: Record<string, unknown>;
    try {
      library = requiredRecord(await this.coreRequest<unknown>("/videolibrary", {
        method: "POST",
        body: JSON.stringify({ Name: name, AllowDirectPlay: true }),
      }), "Bunny video-library response");
    } catch (error) {
      if (error instanceof BunnyApiError && error.definitiveRejection) {
        throw new TenantSpaceCreationRejectedError("Bunny rejected tenant-space creation", { cause: error });
      }
      throw error;
    }
    const libraryId = requiredPositiveIntegerString(library.Id, "Bunny library Id");
    const pullZoneId = requiredPositiveIntegerString(library.PullZoneId, "Bunny PullZoneId");
    const pullZone = requiredRecord(
      await this.coreRequest<unknown>(`/pullzone/${encodeURIComponent(pullZoneId)}`),
      "Bunny pull-zone response",
    );
    const hostnames = Array.isArray(pullZone.Hostnames) ? pullZone.Hostnames : [];
    const hostname = hostnames
      .map((entry) => isRecord(entry) ? entry.Value : undefined)
      .find((value): value is string => typeof value === "string"
        && isBunnyPullZoneHostname(value.trim().toLowerCase()));

    const credentials = validateLibraryCredentials({
      libraryId,
      apiKey: requiredSecret(library.ApiKey, "Bunny library ApiKey"),
      readOnlyApiKey: requiredSecret(library.ReadOnlyApiKey, "Bunny library ReadOnlyApiKey"),
      pullZoneId,
      pullZoneHostname: requiredPullZoneHostname(hostname),
      zoneSecurityKey: requiredSecret(pullZone.ZoneSecurityKey, "Bunny ZoneSecurityKey"),
      zoneSecurityEnabled: pullZone.ZoneSecurityEnabled === true,
    });
    await this.options.onLibraryCreated?.(credentials);
    this.libraries.set(libraryId, credentials);
    return { id: libraryId };
  }

  async setEncodeCompletionCallback(space: TenantSpace, webhookUrl: string): Promise<void> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const callbackUrl = requiredSafeWebhookUrl(webhookUrl);
    try {
      await this.coreRequest(`/videolibrary/${encodeURIComponent(spaceId)}`, {
        method: "POST",
        body: JSON.stringify({ WebhookUrl: callbackUrl }),
      });
    } catch (error) {
      if (error instanceof BunnyApiError && error.definitiveRejection) {
        throw new EncodeCompletionCallbackRejectedError(
          "Bunny rejected encode-completion callback configuration",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async deleteTenantSpace(space: TenantSpace): Promise<void> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    await this.coreRequest(`/videolibrary/${encodeURIComponent(spaceId)}`, { method: "DELETE" });
    this.libraries.delete(spaceId);
  }

  async createAsset(space: TenantSpace, input: { title: string }): Promise<Asset> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const title = requiredInputString(input.title, "Asset title");
    const credentials = await this.credentials(spaceId);
    let response: Record<string, unknown>;
    try {
      response = requiredRecord(await this.streamRequest<unknown>(
        credentials,
        `/library/${spaceId}/videos`,
        { method: "POST", body: JSON.stringify({ title }) },
      ), "Bunny video response");
    } catch (error) {
      if (error instanceof BunnyApiError && error.definitiveRejection) {
        throw new AssetCreationRejectedError("Bunny rejected video asset creation", { cause: error });
      }
      throw error;
    }
    return { id: requiredProviderIdentifier(response.guid, "Bunny video guid") };
  }

  async getUploadCredentials(
    space: TenantSpace,
    asset: Asset,
    input: { fileName: string; contentType: string; contentLength: number },
  ): Promise<UploadCredentials> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const assetId = requiredProviderIdentifier(asset.id, "Bunny video guid");
    validateUploadInput(input);
    const credentials = await this.credentials(spaceId);
    const expiration = Math.floor(this.now() / 1000) + 60 * 60;
    const signature = createHash("sha256")
      .update(`${spaceId}${credentials.apiKey}${expiration}${assetId}`)
      .digest("hex");
    return {
      kind: "tus",
      endpoint: `${STREAM_API}/tusupload`,
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expiration),
        LibraryId: spaceId,
        VideoId: assetId,
      },
      expiresAt: new Date(expiration * 1000).toISOString(),
    };
  }

  async getAssetStatus(space: TenantSpace, asset: Asset): Promise<AssetStatus> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const assetId = requiredProviderIdentifier(asset.id, "Bunny video guid");
    const credentials = await this.credentials(spaceId);
    const video = requiredRecord(await this.streamRequest<unknown>(
      credentials,
      `/library/${spaceId}/videos/${encodeURIComponent(assetId)}`,
    ), "Bunny video-status response");
    const status = requiredInteger(video.status, "Bunny video status");
    if (status === 3) {
      return {
        state: "ready",
        durationSeconds: video.length === undefined
          ? 0
          : requiredNonnegativeNumber(video.length, "Bunny video duration"),
      };
    }
    if (status === 5 || status === 8) return { state: "error", reason: `Bunny status ${status}` };
    if (status === 0) return { state: "created" };
    if (status === 6) return { state: "uploading" };
    if (status === 1 || status === 2 || status === 4 || status === 7) return { state: "processing" };
    return { state: "error", reason: "Bunny returned an unknown asset status" };
  }

  async deleteAsset(space: TenantSpace, asset: Asset): Promise<void> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const assetId = requiredProviderIdentifier(asset.id, "Bunny video guid");
    const credentials = await this.credentials(spaceId);
    await this.streamRequest(
      credentials,
      `/library/${spaceId}/videos/${encodeURIComponent(assetId)}`,
      { method: "DELETE" },
    );
  }

  async getPlaybackSources(space: TenantSpace, asset: Asset): Promise<PlaybackSources> {
    const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
    const assetId = requiredProviderIdentifier(asset.id, "Bunny video guid");
    const credentials = await this.credentials(spaceId);
    if (!credentials.zoneSecurityEnabled) {
      throw new Error(`Bunny CDN token authentication is not enabled for library ${spaceId}`);
    }
    const expires = Math.floor(this.now() / 1000) + 15 * 60;
    const directory = `/${assetId}/`;
    // Bunny Advanced Token Authentication (2026 HMAC-SHA256 format):
    // HS256- + base64url(HMAC(key, protectedDirectory + expiry)).
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

  async isPlaybackSourceTrusted(space: TenantSpace, asset: Asset, value: string): Promise<boolean> {
    let credentials: BunnyLibraryCredentials;
    let assetId: string;
    try {
      const spaceId = requiredPositiveIntegerString(space.id, "Bunny library Id");
      assetId = requiredProviderIdentifier(asset.id, "Bunny video guid");
      credentials = await this.credentials(spaceId);
    } catch {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && !url.username
        && !url.password
        && !url.port
        && !url.hash
        && !url.search
        && url.hostname.toLowerCase() === credentials.pullZoneHostname
        && isExpectedPlaybackPath(url.pathname, assetId, this.now());
    } catch {
      return false;
    }
  }

  verifyEncodeCompletionCallback(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    if (header(headers, "x-bunnystream-signature-version") !== "v1") return null;
    if (header(headers, "x-bunnystream-signature-algorithm") !== "hmac-sha256") return null;
    const signature = header(headers, "x-bunnystream-signature");
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return null;

    let payload: BunnyWebhookBody;
    try {
      payload = parseWebhook(rawBody);
    } catch {
      return null;
    }
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
        ? { state: "ready", durationSeconds: payload.Length ?? 0 }
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
    const resolved = validateLibraryCredentials(await this.options.resolveLibraryCredentials(libraryId));
    if (resolved.libraryId !== libraryId) {
      throw new Error(`Bunny credential resolver returned the wrong library`);
    }
    // Resolver-backed credentials are intentionally not cached so rotations and
    // revocations take effect on the next operation.
    return resolved;
  }

  private coreRequest<T = unknown>(path: string, init: RequestInit = {}) {
    return request<T>(
      `${CORE_API}${path}`,
      this.accountApiKey,
      init,
      this.fetchImpl,
      this.requestTimeoutMs,
    );
  }

  private streamRequest<T = unknown>(
    credentials: BunnyLibraryCredentials,
    path: string,
    init: RequestInit = {},
  ) {
    return request<T>(
      `${STREAM_API}${path}`,
      credentials.apiKey,
      init,
      this.fetchImpl,
      this.requestTimeoutMs,
    );
  }
}

async function request<T>(
  url: string,
  accessKey: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const parsedUrl = new URL(url);
  const method = init.method ?? "GET";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Bunny request timed out")), timeoutMs);
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: { AccessKey: accessKey, "Content-Type": "application/json", ...init.headers },
    });
  } catch (error) {
    throw new Error(`Bunny API ${method} ${parsedUrl.pathname} request failed`, { cause: error });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) {
    // Do not include upstream response text: provider responses can contain
    // sensitive account details and errors are logged by queue infrastructure.
    throw new BunnyApiError(method, parsedUrl.pathname, response.status);
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`Bunny API ${method} ${parsedUrl.pathname} returned invalid JSON`, { cause: error });
  }
}

function requiredInputString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} was missing from the Bunny response`);
  }
  return value.trim();
}

function requiredPositiveIntegerString(value: unknown, label: string): string {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${label} was invalid`);
  }
  return normalized;
}

function requiredProviderIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} was invalid`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(number)) throw new Error(`${label} was invalid`);
  return number;
}

function requiredNonnegativeNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} was invalid`);
  return number;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was invalid`);
  return value;
}

function requiredPullZoneHostname(value: unknown): string {
  if (typeof value !== "string") throw new Error("Bunny pull-zone hostname was missing");
  const hostname = value.trim().toLowerCase();
  if (!isBunnyPullZoneHostname(hostname)) throw new Error("Bunny pull-zone hostname was invalid");
  return hostname;
}

function isBunnyPullZoneHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.b-cdn\.net$/.test(value);
}

function validateLibraryCredentials(value: BunnyLibraryCredentials): BunnyLibraryCredentials {
  return {
    libraryId: requiredPositiveIntegerString(value.libraryId, "Bunny library Id"),
    apiKey: requiredSecret(value.apiKey, "Bunny library ApiKey"),
    readOnlyApiKey: requiredSecret(value.readOnlyApiKey, "Bunny library ReadOnlyApiKey"),
    pullZoneId: requiredPositiveIntegerString(value.pullZoneId, "Bunny PullZoneId"),
    pullZoneHostname: requiredPullZoneHostname(value.pullZoneHostname),
    zoneSecurityKey: requiredSecret(value.zoneSecurityKey, "Bunny ZoneSecurityKey"),
    zoneSecurityEnabled: value.zoneSecurityEnabled === true,
  };
}

function validateUploadInput(input: { fileName: string; contentType: string; contentLength: number }): void {
  requiredInputString(input.fileName, "Upload file name");
  if (!/^video\/[A-Za-z0-9.+-]{1,127}$/.test(input.contentType)) {
    throw new Error("Upload content type must be a video media type");
  }
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
    throw new Error("Upload content length must be a positive safe integer");
  }
}

function requiredSafeWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bunny callback URL must be a valid HTTPS URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || isIP(hostname) !== 0) {
    throw new Error("Bunny callback URL must be a safe HTTPS URL");
  }
  return url.toString();
}

function isExpectedPlaybackPath(pathname: string, assetId: string, nowMs: number): boolean {
  const match = /^\/bcdn_token=HS256-([A-Za-z0-9_-]{43})&expires=(\d{1,12})\/([^/]+)\/(playlist\.m3u8|thumbnail\.jpg)$/
    .exec(pathname);
  if (!match) return false;
  const expires = Number(match[2]);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1000)) return false;
  try {
    return decodeURIComponent(match[3]) === assetId;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWebhook(rawBody: Buffer): BunnyWebhookBody {
  if (rawBody.length === 0 || rawBody.length > 64 * 1024) throw new Error("Invalid Bunny webhook body size");
  const value: unknown = JSON.parse(rawBody.toString("utf8"));
  if (!isRecord(value)) throw new Error("Invalid Bunny webhook body");
  const libraryId = value.VideoLibraryId;
  const status = value.Status;
  const length = value.Length;
  if (!Number.isSafeInteger(libraryId) || (libraryId as number) <= 0
    || typeof value.VideoGuid !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.VideoGuid)
    || !Number.isInteger(status)) {
    throw new Error("Invalid Bunny webhook fields");
  }
  if (length !== undefined && (typeof length !== "number" || !Number.isFinite(length) || length < 0)) {
    throw new Error("Invalid Bunny webhook duration");
  }
  return {
    VideoLibraryId: libraryId as number,
    VideoGuid: value.VideoGuid,
    Status: status as number,
    Length: length as number | undefined,
  };
}

/**
 * Reads only the routing identifier needed to select candidate account-backed
 * adapters. No status or asset field returned by this parse may be trusted.
 */
export function inspectBunnyEncodeCompletionCallback(rawBody: Buffer): { tenantSpaceId: string } {
  return { tenantSpaceId: String(parseWebhook(rawBody).VideoLibraryId) };
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  }
  return undefined;
}