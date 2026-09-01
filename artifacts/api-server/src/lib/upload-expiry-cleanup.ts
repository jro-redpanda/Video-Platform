import {
  db,
  organizationsTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
} from "@workspace/db";
import type { VideoProvider } from "@workspace/providers";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { resolveProvisioningProvider, type ProvisioningProviderResolver } from "./provider-registry";

export type UploadCleanupResult = {
  examined: number;
  released: number;
  reconciliationRequired: number;
};

/**
 * Reclaims abandoned upload reservations. Provider deletion must be confirmed
 * before quota is released; unknown outcomes are retained for reconciliation.
 */
export async function cleanupExpiredUploads(
  resolveProvider: ProvisioningProviderResolver = resolveProvisioningProvider,
  now = new Date(),
): Promise<UploadCleanupResult> {
  const expired = await db.select().from(videosTable).where(and(
    lt(videosTable.reservationExpiresAt, now),
    isNull(videosTable.quotaReleasedAt),
    isNull(videosTable.reconciliationRequired),
    isNull(videosTable.assetCreationClaim),
  ));
  const result: UploadCleanupResult = { examined: expired.length, released: 0, reconciliationRequired: 0 };

  for (const video of expired) {
    try {
      if (video.providerAssetId && video.providerAccountId && video.providerTenantSpaceId) {
        const [link] = await db.select({ account: providerAccountsTable, space: providerTenantSpacesTable })
          .from(providerTenantSpacesTable)
          .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
          .where(and(
            eq(providerTenantSpacesTable.organizationId, video.organizationId),
            eq(providerTenantSpacesTable.providerAccountId, video.providerAccountId),
            eq(providerTenantSpacesTable.providerSpaceId, video.providerTenantSpaceId),
          )).limit(1);
        if (!link) throw new Error("Stored provider linkage is unavailable");
        const provider: VideoProvider = await resolveProvider(link.account, link.space);
        await provider.deleteAsset({ id: video.providerTenantSpaceId }, { id: video.providerAssetId });
      }
    } catch {
      await db.update(videosTable).set({
        status: "error",
        reconciliationRequired: "expired upload provider deletion outcome unknown",
        initializationRetryable: false,
        uploadFailureDetail: "Expired upload requires provider reconciliation.",
      }).where(and(eq(videosTable.id, video.id), isNull(videosTable.quotaReleasedAt)));
      result.reconciliationRequired += 1;
      continue;
    }

    const released = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${video.organizationId}))`);
      const [claimed] = await tx.update(videosTable).set({
        status: "error",
        uploadFailureDetail: "Upload reservation expired",
        quotaReleasedAt: now,
        initializationRetryable: false,
      }).where(and(
        eq(videosTable.id, video.id),
        eq(videosTable.organizationId, video.organizationId),
        isNull(videosTable.quotaReleasedAt),
        isNull(videosTable.reconciliationRequired),
        isNull(videosTable.assetCreationClaim),
      )).returning({ reservedBytes: videosTable.reservedBytes });
      if (!claimed) return false;
      await tx.update(organizationsTable).set({
        storageUsedBytes: sql`greatest(0, ${organizationsTable.storageUsedBytes} - ${claimed.reservedBytes})`,
      }).where(eq(organizationsTable.id, video.organizationId));
      return true;
    });
    if (released) result.released += 1;
  }
  return result;
}