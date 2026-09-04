import type { Response } from "express";
import type { Asset, PlaybackSources, TenantSpace, VideoProvider } from "@workspace/providers";

const minimumPlaybackFreshnessMs = 30_000;

export type ValidatedPlaybackSource = {
  sourceUrl: string;
  expiresAt: Date;
};

export async function validatePlaybackSource(
  provider: VideoProvider,
  space: TenantSpace,
  asset: Asset,
  sources: PlaybackSources,
  now = new Date(),
): Promise<ValidatedPlaybackSource> {
  if (!sources.hlsUrl) throw new Error("Provider returned no maintained HLS playback source");
  const expiresAt = new Date(sources.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() < now.getTime() + minimumPlaybackFreshnessMs) {
    throw new Error("Provider returned an expired or near-expiry playback source");
  }

  const parsed = new URL(sources.hlsUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw new Error("Provider returned an unsafe playback source URL");
  }
  const sourceUrl = parsed.toString();
  if (!await provider.isPlaybackSourceTrusted(space, asset, sourceUrl)) {
    throw new Error("Provider returned an untrusted playback source");
  }
  return { sourceUrl, expiresAt };
}

export function setPlaybackResponsePolicy(res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}