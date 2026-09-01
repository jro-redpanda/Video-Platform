import type {
  Asset,
  AssetStatus,
  EncodeCompletionEvent,
  PlaybackSources,
  ProviderCapabilities,
  TenantSpace,
  UploadCredentials,
  VideoProvider,
} from "./contracts";

export class ProviderNotConfiguredError extends Error {
  constructor(providerKey: string) {
    super(`Video provider "${providerKey}" is not configured`);
    this.name = "ProviderNotConfiguredError";
  }
}

// MOCK: replaced at step 18
export class UnconfiguredVideoProvider implements VideoProvider {
  readonly capabilities: ProviderCapabilities = {
    durableStorage: true,
    multiRenditionTranscoding: true,
    manifestFormats: ["hls", "dash"],
    cdnDelivery: true,
    uploadMethods: ["tus", "multipart"],
    signedPlaybackUrls: true,
    encodeCompletionCallback: true,
  };

  constructor(readonly key: string) {}

  private unavailable(): never {
    throw new ProviderNotConfiguredError(this.key);
  }

  async createTenantSpace(_input: { name: string }): Promise<TenantSpace> {
    return this.unavailable();
  }

  async deleteTenantSpace(_space: TenantSpace): Promise<void> {
    return this.unavailable();
  }

  async createAsset(_space: TenantSpace, _input: { title: string }): Promise<Asset> {
    return this.unavailable();
  }

  getUploadCredentials(
    _space: TenantSpace,
    _asset: Asset,
    _input: { fileName: string; contentType: string; contentLength: number },
  ): Promise<UploadCredentials> {
    return this.unavailable();
  }

  async getAssetStatus(_space: TenantSpace, _asset: Asset): Promise<AssetStatus> {
    return this.unavailable();
  }

  async deleteAsset(_space: TenantSpace, _asset: Asset): Promise<void> {
    return this.unavailable();
  }

  async getPlaybackSources(_space: TenantSpace, _asset: Asset): Promise<PlaybackSources> {
    return this.unavailable();
  }

  verifyEncodeCompletionCallback(
    _rawBody: Buffer,
    _headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    this.unavailable();
  }
}