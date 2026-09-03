import { providerAccountsTable, providerTenantSpacesTable } from "@workspace/db";
import { BunnyVideoProvider, type BunnyLibraryCredentials, UnconfiguredVideoProvider, VideoProviderRegistry, type VideoProvider } from "@workspace/providers";
import { and, eq } from "drizzle-orm";
import { decryptProviderCredentials, encryptProviderCredentials } from "./credential-encryption";
import { runtimeConfig } from "./config";
import { withWorkerDb } from "./worker-db";

export const videoProviders = new VideoProviderRegistry();
const bunnyAccountApiKey = process.env.BUNNY_API_KEY;
if (bunnyAccountApiKey) {
  videoProviders.register(new BunnyVideoProvider({
    accountApiKey: bunnyAccountApiKey,
    resolveLibraryCredentials: async () => {
      throw new Error("A tenant-bound Bunny provider is required");
    },
  }));
} else {
  // Live Bunny remains explicitly unconfigured rather than falling back to a fake.
  videoProviders.register(new UnconfiguredVideoProvider("bunny"));
}
videoProviders.register(new UnconfiguredVideoProvider("secondary"));

export type ProvisioningProviderResolver = (
  account: typeof providerAccountsTable.$inferSelect,
  space: typeof providerTenantSpacesTable.$inferSelect,
) => Promise<VideoProvider>;

export type ProviderEncodeCallbackUrlResolver = (provider: VideoProvider) => string | undefined;

/** Returns the owned callback URL for adapters that advertise callback support. */
export const resolveProviderEncodeCallbackUrl: ProviderEncodeCallbackUrlResolver = (provider) => {
  if (!provider.capabilities.encodeCompletionCallback) return undefined;
  if (provider.key === "bunny") {
    return `https://${runtimeConfig.appDomain}/api/webhooks/bunny/encode`;
  }
  if (process.env.NODE_ENV === "test" && provider.key === "step7-smoke") {
    return "https://callbacks.test.invalid/provider/encode";
  }
  throw new Error(`No encode callback endpoint is configured for provider "${provider.key}"`);
};

/** Builds a provider from the selected global account; never uses a singleton account credential. */
export const resolveProvisioningProvider: ProvisioningProviderResolver = async (account, space) => {
  if (account.providerKey !== "bunny") return videoProviders.resolve(account.providerKey);
  const credentials = decryptProviderCredentials(account.encryptedCredentials);
  const accountApiKey = credentials.accountApiKey;
  if (!accountApiKey) throw new Error(`Stored Bunny account credentials are invalid for account ${account.id}`);
  return new BunnyVideoProvider({
    accountApiKey,
    resolveLibraryCredentials: selectedLibraryResolver(space),
    onLibraryCreated: async (library) => {
      const updated = await withWorkerDb("onboarding", (tx) =>
        tx.update(providerTenantSpacesTable).set({
          providerSpaceId: library.libraryId,
          encryptedCredentials: encryptLibraryCredentials(library),
          metadata: libraryMetadata(library),
        }).where(and(
          eq(providerTenantSpacesTable.id, space.id),
          eq(providerTenantSpacesTable.state, "creating"),
          eq(providerTenantSpacesTable.idempotencyKey, space.idempotencyKey),
        )).returning({ id: providerTenantSpacesTable.id }));
      if (!updated.length) throw new Error(`Reserved tenant space ${space.id} is no longer available`);
    },
  });
};

/** Constructs a Bunny adapter tied to one persisted account and preloads only its selected space. */
export async function resolveBunnyWebhookProvider(
  account: typeof providerAccountsTable.$inferSelect,
  space: typeof providerTenantSpacesTable.$inferSelect,
) {
  if (account.providerKey !== "bunny" || !space.providerSpaceId) {
    throw new Error("Bunny webhook candidate is invalid");
  }
  const accountSecrets = decryptProviderCredentials(account.encryptedCredentials);
  if (typeof accountSecrets.accountApiKey !== "string" || !accountSecrets.accountApiKey) {
    throw new Error(`Stored Bunny account credentials are invalid for account ${account.id}`);
  }
  const webhookCredentials = libraryCredentialsFromSpace(space);
  return new BunnyVideoProvider({
    accountApiKey: accountSecrets.accountApiKey,
    resolveLibraryCredentials: selectedLibraryResolver(space),
    webhookCredentials,
  });
}

function selectedLibraryResolver(space: typeof providerTenantSpacesTable.$inferSelect) {
  return async (libraryId: string): Promise<BunnyLibraryCredentials> => {
    if (space.providerSpaceId !== libraryId) {
      throw new Error(`Stored Bunny credentials are unavailable for library ${libraryId}`);
    }
    return libraryCredentialsFromSpace(space);
  };
}

function libraryCredentialsFromSpace(
  space: typeof providerTenantSpacesTable.$inferSelect,
): BunnyLibraryCredentials {
  const libraryId = space.providerSpaceId;
  if (!libraryId || !space.encryptedCredentials) {
    throw new Error(`Stored Bunny credentials are unavailable for tenant space ${space.id}`);
  }
  const secrets = decryptProviderCredentials(space.encryptedCredentials);
  const metadata = space.metadata;
  if (
    typeof secrets.apiKey !== "string" || typeof secrets.readOnlyApiKey !== "string"
    || typeof secrets.zoneSecurityKey !== "string" || typeof metadata.pullZoneId !== "string"
    || typeof metadata.pullZoneHostname !== "string" || typeof metadata.zoneSecurityEnabled !== "boolean"
  ) {
    throw new Error(`Stored Bunny credentials are invalid for library ${libraryId}`);
  }
  return {
    libraryId, apiKey: secrets.apiKey, readOnlyApiKey: secrets.readOnlyApiKey,
    zoneSecurityKey: secrets.zoneSecurityKey, pullZoneId: metadata.pullZoneId,
    pullZoneHostname: metadata.pullZoneHostname, zoneSecurityEnabled: metadata.zoneSecurityEnabled,
  };
}

function encryptLibraryCredentials(library: BunnyLibraryCredentials) {
  return encryptProviderCredentials({
    apiKey: library.apiKey, readOnlyApiKey: library.readOnlyApiKey, zoneSecurityKey: library.zoneSecurityKey,
  });
}

function libraryMetadata(library: BunnyLibraryCredentials) {
  return {
    pullZoneId: library.pullZoneId, pullZoneHostname: library.pullZoneHostname,
    zoneSecurityEnabled: library.zoneSecurityEnabled,
  };
}