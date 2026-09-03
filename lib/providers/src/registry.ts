import type { VideoProvider } from "./contracts.js";
import { UnconfiguredVideoProvider } from "./unconfigured.js";

export class VideoProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>();
  private readonly unavailableProviders = new Map<string, UnconfiguredVideoProvider>();

  register(provider: VideoProvider): void {
    const providerKey = validateProviderKey(provider.key);
    if (this.providers.has(providerKey)) {
      throw new Error(`Video provider "${providerKey}" is already registered`);
    }
    this.providers.set(providerKey, provider);
    this.unavailableProviders.delete(providerKey);
  }

  resolve(providerKey: string): VideoProvider {
    const validatedKey = validateProviderKey(providerKey);
    const provider = this.providers.get(validatedKey);
    if (provider) return provider;
    const existing = this.unavailableProviders.get(validatedKey);
    if (existing) return existing;
    const unavailable = new UnconfiguredVideoProvider(validatedKey);
    this.unavailableProviders.set(validatedKey, unavailable);
    return unavailable;
  }
}

function validateProviderKey(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("Video provider key must be a lowercase identifier");
  }
  return value;
}
