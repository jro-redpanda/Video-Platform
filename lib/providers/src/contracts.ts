export type ManifestFormat = "hls" | "dash";
export type UploadMethod = "tus" | "multipart";

export type ProviderCapabilities = Readonly<{
  durableStorage: true;
  multiRenditionTranscoding: true;
  manifestFormats: readonly ManifestFormat[];
  cdnDelivery: true;
  uploadMethods: readonly UploadMethod[];
  signedPlaybackUrls: true;
  encodeCompletionCallback: true;
}>;

export type TenantSpace = {
  id: string;
};

/** A provider received and rejected a create request; no tenant space was created. */
export class TenantSpaceCreationRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TenantSpaceCreationRejectedError";
  }
}

/** A provider definitively rejected asset creation, so its local reservation may be removed. */
export class AssetCreationRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssetCreationRejectedError";
  }
}

export type Asset = {
  id: string;
};

export type AssetStatus =
  | { state: "created" | "uploading" | "processing" }
  | { state: "ready"; durationSeconds: number }
  | { state: "error"; reason: string };

export type TusUploadCredentials = {
  kind: "tus";
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
};

export type MultipartUploadCredentials = {
  kind: "multipart";
  uploadId: string;
  partSizeBytes: number;
  parts: ReadonlyArray<{
    number: number;
    url: string;
    headers: Readonly<Record<string, string>>;
  }>;
  completeUrl: string;
  expiresAt: string;
};

export type UploadCredentials = TusUploadCredentials | MultipartUploadCredentials;

export type PlaybackSources = {
  hlsUrl?: string;
  dashUrl?: string;
  posterUrl?: string;
  expiresAt: string;
};

export type EncodeCompletionEvent = {
  eventId: string;
  tenantSpaceId: string;
  assetId: string;
  status: Extract<AssetStatus, { state: "ready" | "error" }>;
  occurredAt: string;
};

export interface VideoProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;

  createTenantSpace(input: { name: string }): Promise<TenantSpace>;
  deleteTenantSpace(space: TenantSpace): Promise<void>;
  createAsset(space: TenantSpace, input: { title: string }): Promise<Asset>;
  getUploadCredentials(
    space: TenantSpace,
    asset: Asset,
    input: { fileName: string; contentType: string; contentLength: number },
  ): Promise<UploadCredentials>;
  getAssetStatus(space: TenantSpace, asset: Asset): Promise<AssetStatus>;
  deleteAsset(space: TenantSpace, asset: Asset): Promise<void>;
  getPlaybackSources(space: TenantSpace, asset: Asset): Promise<PlaybackSources>;
  verifyEncodeCompletionCallback(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null;
}