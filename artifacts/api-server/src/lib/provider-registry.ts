import { BunnyVideoProvider, UnconfiguredVideoProvider, VideoProviderRegistry } from "@workspace/providers";

export const videoProviders = new VideoProviderRegistry();
const bunnyAccountApiKey = process.env.BUNNY_API_KEY;
if (!bunnyAccountApiKey) throw new Error("BUNNY_API_KEY is required");
videoProviders.register(new BunnyVideoProvider({ accountApiKey: bunnyAccountApiKey }));
videoProviders.register(new UnconfiguredVideoProvider("secondary"));