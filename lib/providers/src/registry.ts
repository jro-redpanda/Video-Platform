import type { VideoProvider } from "./contracts";
import { UnconfiguredVideoProvider } from "./unconfigured";

export class VideoProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>();

  register(provider: VideoProvider) {
    if (this.providers.has(provider.key)) {
      throw new Error(`Video provider "${provider.key}" is already registered`);
    }
    this.providers.set(provider.key, provider);
  }

  resolve(providerKey: string) {
    return this.providers.get(providerKey) ?? new UnconfiguredVideoProvider(providerKey);
  }
}