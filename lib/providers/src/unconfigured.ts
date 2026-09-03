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

export class ProviderNotConfiguredError extends Error {
  constructor(providerKey: string) {
    super(`Video provider "${providerKey}" is not configured`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class UnconfiguredVideoProvider implements VideoProvider {
  readonly availability = { state: "unavailable", reason: "not_configured" } as const;
  readonly capabilities: ProviderCapabilities = {
    durableStorage: false,
    multiRenditionTranscoding: false,
    manifestFormats: [],
    cdnDelivery: false,
    uploadMethods: [],
    signedPlaybackUrls: false,
    encodeCompletionCallback: false,
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

  async isPlaybackSourceTrusted(_space: TenantSpace, _url: string): Promise<boolean> {
    return false;
  }

  verifyEncodeCompletionCallback(
    _rawBody: Buffer,
    _headers: Readonly<Record<string, string | string[] | undefined>>,
  ): EncodeCompletionEvent | null {
    this.unavailable();
  }
}