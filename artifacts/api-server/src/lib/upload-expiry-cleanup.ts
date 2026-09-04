import {
  organizationsTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
} from "@workspace/db";
import type { VideoProvider } from "@workspace/providers";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { resolveProvisioningProvider, type ProvisioningProviderResolver } from "./provider-registry";
import { withWorkerDb } from "./worker-db";

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
  const staleAssetClaims = await withWorkerDb("upload_expiry", (tx) =>
    tx.update(videosTable).set({
      status: "error",
      reconciliationRequired: "provider asset creation outcome unknown",
      initializationRetryable: false,
      uploadFailureDetail: "Upload initialization requires provider reconciliation.",
    }).where(and(
      inArray(videosTable.status, ["created", "error"]),
      isNotNull(videosTable.assetCreationClaim),
      lt(videosTable.assetCreationClaimedAt, new Date(now.getTime() - 15 * 60_000)),
      isNull(videosTable.quotaReleasedAt),
      isNull(videosTable.reconciliationRequired),
    )).returning({ id: videosTable.id }));
  await withWorkerDb("upload_expiry", (tx) =>
    tx.update(videosTable).set({
      status: "error",
      reconciliationRequired: "expired upload provider deletion outcome unknown",
      initializationRetryable: false,
      uploadFailureDetail: "Expired upload requires provider reconciliation.",
    }).where(and(
      eq(videosTable.status, "uploading"),
      lt(videosTable.reservationExpiresAt, now),
      isNull(videosTable.quotaReleasedAt),
      isNull(videosTable.reconciliationRequired),
      isNotNull(videosTable.deletionClaim),
      lt(videosTable.deletionClaimedAt, new Date(now.getTime() - 15 * 60_000)),
    )));
  const expired = await withWorkerDb("upload_expiry", (tx) =>
    tx.select().from(videosTable).where(and(
      eq(videosTable.status, "uploading"),
      lt(videosTable.reservationExpiresAt, now),
      isNull(videosTable.quotaReleasedAt),
      isNull(videosTable.reconciliationRequired),
      isNull(videosTable.assetCreationClaim),
      isNull(videosTable.deletionClaim),
    )));
  const result: UploadCleanupResult = {
    examined: expired.length + staleAssetClaims.length,
    released: 0,
    reconciliationRequired: staleAssetClaims.length,
  };

  for (const video of expired) {
    // Claim before the provider side effect. Upload completion requires the
    // same row to remain uploading without a reconciliation marker, so either
    // completion wins first or cleanup does; cleanup can never delete an asset
    // that was acknowledged while this worker was waiting.
    const claim = randomUUID();
    const [claimed] = await withWorkerDb("upload_expiry", (tx) =>
      tx.update(videosTable).set({
        deletionClaim: claim,
        deletionClaimedAt: now,
      }).where(and(
        eq(videosTable.id, video.id),
        eq(videosTable.organizationId, video.organizationId),
        eq(videosTable.status, "uploading"),
        lt(videosTable.reservationExpiresAt, now),
        isNull(videosTable.quotaReleasedAt),
        isNull(videosTable.reconciliationRequired),
        isNull(videosTable.assetCreationClaim),
        isNull(videosTable.deletionClaim),
      )).returning());
    if (!claimed) continue;

    try {
      if (video.providerAssetId && video.providerAccountId && video.providerTenantSpaceId) {
        const providerAccountId = video.providerAccountId;
        const providerTenantSpaceId = video.providerTenantSpaceId;
        const [link] = await withWorkerDb("upload_expiry", (tx) =>
          tx.select({ account: providerAccountsTable, space: providerTenantSpacesTable })
            .from(providerTenantSpacesTable)
            .innerJoin(providerAccountsTable, eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId))
            .where(and(
              eq(providerTenantSpacesTable.organizationId, video.organizationId),
              eq(providerTenantSpacesTable.providerAccountId, providerAccountId),
              eq(providerTenantSpacesTable.providerSpaceId, providerTenantSpaceId),
            )).limit(1));
        if (!link) throw new Error("Stored provider linkage is unavailable");
        const provider: VideoProvider = await resolveProvider(link.account, link.space);
        await provider.deleteAsset({ id: providerTenantSpaceId }, { id: video.providerAssetId });
      }
    } catch {
      await withWorkerDb("upload_expiry", (tx) =>
        tx.update(videosTable).set({
          status: "error",
          reconciliationRequired: "expired upload provider deletion outcome unknown",
          initializationRetryable: false,
          uploadFailureDetail: "Expired upload requires provider reconciliation.",
        }).where(and(
          eq(videosTable.id, video.id),
          isNull(videosTable.quotaReleasedAt),
          eq(videosTable.deletionClaim, claim),
        )));
      result.reconciliationRequired += 1;
      continue;
    }

    const released = await withWorkerDb("upload_expiry", async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${video.organizationId}))`);
      const [claimed] = await tx.update(videosTable).set({
        status: "error",
        uploadFailureDetail: "Upload reservation expired",
        quotaReleasedAt: now,
        initializationRetryable: false,
        deletionClaim: null,
        deletionClaimedAt: null,
      }).where(and(
        eq(videosTable.id, video.id),
        eq(videosTable.organizationId, video.organizationId),
        eq(videosTable.status, "uploading"),
        isNull(videosTable.quotaReleasedAt),
        isNull(videosTable.reconciliationRequired),
        eq(videosTable.deletionClaim, claim),
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