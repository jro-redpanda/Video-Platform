import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  db,
  groupPermissionsTable,
  membershipsTable,
  organizationsTable,
  permissionGroupsTable,
  permissionsTable,
  plansTable,
  providerAccountsTable,
  providerTenantSpacesTable,
  usersTable,
  videosTable,
} from "@workspace/db";
import { Step7SmokeVideoProvider } from "@workspace/providers/test-only";
import { and, eq, sql } from "drizzle-orm";
import app from "./app";
import { cleanupExpiredUploads } from "./lib/upload-expiry-cleanup";
import { videoProviders } from "./lib/provider-registry";
import { registerStep7SmokeProvider } from "./lib/test-only-provider-registry";
import { setBeforeAssetCreationClaimForTest } from "./routes/platform";

assert.equal(process.env.NODE_ENV, "test", "upload smoke must run with NODE_ENV=test");
registerStep7SmokeProvider();
const suffix = randomUUID();
const planId = randomUUID();
const organizationId = randomUUID();
const accountId = randomUUID();
const groupId = randomUUID();
const email = `step9-${suffix}@example.test`;
const provider = videoProviders.resolve("step7-smoke") as Step7SmokeVideoProvider;
const server = app.listen(0);

try {
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Step 9 Smoke", email, password: `Smoke-${suffix}!` }),
  });
  assert.equal(signUp.status, 200);
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert(user);

  await db.insert(plansTable).values({
    id: planId,
    code: `step9-${suffix}`,
    name: "Step 9 smoke",
    storageLimitGb: 1,
    entitlements: { "limits.max_videos": 2, "limits.max_storage_gb": 1 },
  });
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Step 9 smoke", slug: `step9-${suffix}`, status: "active", planId,
  });
  await db.insert(providerAccountsTable).values({
    id: accountId, providerKey: "step7-smoke", label: "Step 9 smoke",
    encryptedCredentials: "test-only", maxZones: 10,
  });
  await db.insert(providerTenantSpacesTable).values({
    organizationId, providerAccountId: accountId, providerSpaceId: `space-${suffix}`,
    idempotencyKey: `space-${suffix}`, state: "created",
  });
  await db.insert(permissionGroupsTable).values({
    id: groupId, organizationId, name: "Step 9 Owners", description: "test",
  });
  await db.insert(permissionsTable).values({
    key: "videos.create", description: "Create videos and upload media",
  }).onConflictDoNothing();
  await db.insert(groupPermissionsTable).values({ groupId, permissionKey: "videos.create" });
  await db.insert(membershipsTable).values({ organizationId, userId: user.id, groupId, status: "active" });

  const init = (key: string, overrides: Record<string, unknown> = {}) => fetch(`${base}/api/videos/upload-init`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      title: "Smoke video", fileName: "smoke.mp4", contentType: "video/mp4", contentLength: 1,
      ...overrides,
    }),
  });

  const concurrent = await Promise.all([0, 1, 2].map((i) => init(`concurrent-${suffix}-${i}`)));
  assert.equal(concurrent.filter((response) => response.ok).length, 2, "max_videos must serialize");
  await db.delete(videosTable).where(eq(videosTable.organizationId, organizationId));
  await db.update(organizationsTable).set({ storageUsedBytes: 0 }).where(eq(organizationsTable.id, organizationId));
  await db.update(plansTable).set({
    entitlements: { "limits.max_videos": 20, "limits.max_storage_gb": 2 / 1073741824 },
  }).where(eq(plansTable.id, planId));
  const storageConcurrent = await Promise.all([0, 1, 2].map((i) => init(`storage-${suffix}-${i}`)));
  assert.equal(storageConcurrent.filter((response) => response.ok).length, 2, "storage limit must serialize");
  await db.delete(videosTable).where(eq(videosTable.organizationId, organizationId));
  await db.update(organizationsTable).set({ storageUsedBytes: 0 }).where(eq(organizationsTable.id, organizationId));
  await db.update(plansTable).set({
    entitlements: { "limits.max_videos": 20, "limits.max_storage_gb": 1 },
  }).where(eq(plansTable.id, planId));

  const preClaimRaceKey = `pre-claim-race-${suffix}`;
  let releasePreClaim!: () => void;
  const preClaimReleased = new Promise<void>((resolve) => { releasePreClaim = resolve; });
  let preClaimPaused!: () => void;
  const preClaimReached = new Promise<void>((resolve) => { preClaimPaused = resolve; });
  setBeforeAssetCreationClaimForTest(async (_videoId, key) => {
    if (key !== preClaimRaceKey) return;
    preClaimPaused();
    await preClaimReleased;
  });
  const preClaimCreateCalls = provider.createAssetCalls;
  const preClaimInitialization = init(preClaimRaceKey);
  await preClaimReached;
  const [preClaimRaceVideo] = await db.select({ id: videosTable.id }).from(videosTable).where(and(
    eq(videosTable.organizationId, organizationId),
    eq(videosTable.uploadIdempotencyKey, preClaimRaceKey),
  ));
  assert(preClaimRaceVideo);
  assert.equal((await fetch(`${base}/api/videos/${preClaimRaceVideo.id}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: preClaimRaceKey }),
  })).status, 200);
  releasePreClaim();
  assert.equal((await preClaimInitialization).status, 409);
  assert.equal(
    provider.createAssetCalls,
    preClaimCreateCalls,
    "lost claim ownership must prevent provider asset creation",
  );
  setBeforeAssetCreationClaimForTest(undefined);

  const creationRaceKey = `creation-race-${suffix}`;
  const originalCreateAsset = provider.createAsset.bind(provider);
  let releaseAssetCreation!: () => void;
  const assetCreationReleased = new Promise<void>((resolve) => { releaseAssetCreation = resolve; });
  let assetCreationClaimed!: () => void;
  const assetCreationStarted = new Promise<void>((resolve) => { assetCreationClaimed = resolve; });
  provider.createAsset = async (space, input) => {
    assetCreationClaimed();
    await assetCreationReleased;
    return originalCreateAsset(space, input);
  };
  const racingInitialization = init(creationRaceKey);
  await assetCreationStarted;
  const [creationRaceVideo] = await db.select({ id: videosTable.id }).from(videosTable).where(and(
    eq(videosTable.organizationId, organizationId),
    eq(videosTable.uploadIdempotencyKey, creationRaceKey),
  ));
  assert(creationRaceVideo);
  assert.equal((await fetch(`${base}/api/videos/${creationRaceVideo.id}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: creationRaceKey }),
  })).status, 409, "cancellation must not race a fresh provider asset-creation claim");
  releaseAssetCreation();
  assert.equal((await racingInitialization).status, 201);
  provider.createAsset = originalCreateAsset;

  const activationRaceKey = `activation-race-${suffix}`;
  const originalUploadCredentials = provider.getUploadCredentials.bind(provider);
  let releaseUploadCredentials!: () => void;
  const uploadCredentialsReleased = new Promise<void>((resolve) => { releaseUploadCredentials = resolve; });
  let uploadCredentialsRequested!: () => void;
  const uploadCredentialsStarted = new Promise<void>((resolve) => { uploadCredentialsRequested = resolve; });
  provider.getUploadCredentials = async (space, asset, input) => {
    uploadCredentialsRequested();
    await uploadCredentialsReleased;
    return originalUploadCredentials(space, asset, input);
  };
  const losingInitialization = init(activationRaceKey);
  await uploadCredentialsStarted;
  const [activationRaceVideo] = await db.select({ id: videosTable.id }).from(videosTable).where(and(
    eq(videosTable.organizationId, organizationId),
    eq(videosTable.uploadIdempotencyKey, activationRaceKey),
  ));
  assert(activationRaceVideo);
  assert.equal((await fetch(`${base}/api/videos/${activationRaceVideo.id}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: activationRaceKey }),
  })).status, 200);
  releaseUploadCredentials();
  assert.equal((await losingInitialization).status, 409, "lost initialization ownership must not resurrect cancellation");
  const [cancelledActivationRace] = await db.select().from(videosTable)
    .where(eq(videosTable.id, activationRaceVideo.id));
  assert.equal(cancelledActivationRace?.status, "error");
  assert.equal(cancelledActivationRace?.uploadFailureDetail, "Upload cancelled");
  assert.equal(cancelledActivationRace?.quotaReleasedAt instanceof Date, true);
  provider.getUploadCredentials = originalUploadCredentials;

  const key = `idempotent-${suffix}`;
  const beforeCalls = provider.createAssetCalls;
  const first = await init(key);
  const replay = await init(key);
  assert(first.ok && replay.ok);
  const firstBody = await first.json() as Record<string, unknown>;
  const replayBody = await replay.json() as Record<string, unknown>;
  assert.equal(firstBody.videoId, replayBody.videoId);
  assert.equal(provider.createAssetCalls, beforeCalls + 1, "same key must create one provider asset");
  assert.match(String(firstBody.videoId), /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(firstBody).includes(accountId), false);
  assert.equal(JSON.stringify(firstBody).includes(`space-${suffix}`), false);
  const [stored] = await db.select().from(videosTable).where(eq(videosTable.id, String(firstBody.videoId))).limit(1);
  assert(stored?.providerAssetId);
  assert.equal(JSON.stringify(firstBody).includes(stored.providerAssetId), false);
  assert.equal((firstBody.upload as { kind: string }).kind, "tus");
  assert.equal((await init(key, { fileName: "changed.mp4" })).status, 403);

  assert.equal((await fetch(`${base}/api/videos/${firstBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `wrong-${suffix}` }),
  })).status, 409, "completion must be bound to the original upload session");
  const complete = await fetch(`${base}/api/videos/${firstBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key }),
  });
  assert.equal(complete.status, 200);
  assert.equal(((await complete.json()) as { status: string }).status, "processing");
  assert.equal((await fetch(`${base}/api/videos/${firstBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key }),
  })).status, 200, "lost upload acknowledgement responses must be safely replayable");
  assert.equal((await init(key)).status, 409, "processing uploads cannot be resurrected");
  await db.update(videosTable).set({ status: "ready" }).where(eq(videosTable.id, String(firstBody.videoId)));
  assert.equal((await init(key)).status, 409, "ready uploads cannot be resurrected");

  const cancelInit = await init(`cancel-${suffix}`);
  const cancelBody = await cancelInit.json() as { videoId: string };
  const cancelKey = `cancel-${suffix}`;
  const cancel = () => fetch(`${base}/api/videos/${cancelBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: cancelKey }),
  });
  const deletesBeforeWrongSession = provider.deleteAssetCalls;
  assert.equal((await fetch(`${base}/api/videos/${cancelBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `wrong-${suffix}` }),
  })).status, 409);
  assert.equal(provider.deleteAssetCalls, deletesBeforeWrongSession, "wrong session must not delete the provider asset");
  assert.equal((await cancel()).status, 200);
  const deletesAfterFirstCancel = provider.deleteAssetCalls;
  const afterFirstCancel = (await db.select({ bytes: organizationsTable.storageUsedBytes }).from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId)).limit(1))[0]!.bytes;
  assert.equal((await cancel()).status, 200);
  assert.equal(provider.deleteAssetCalls, deletesAfterFirstCancel, "cancel replay must not repeat provider deletion");
  const afterSecondCancel = (await db.select({ bytes: organizationsTable.storageUsedBytes }).from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId)).limit(1))[0]!.bytes;
  assert.equal(afterSecondCancel, afterFirstCancel, "cancel releases quota once");
  const callsBeforeCancelledReplay = provider.createAssetCalls;
  assert.equal((await init(`cancel-${suffix}`)).status, 409, "cancelled upload cannot be resurrected");
  assert.equal(provider.createAssetCalls, callsBeforeCancelledReplay);
  const deletesBeforeTerminalCancel = provider.deleteAssetCalls;
  assert.equal((await fetch(`${base}/api/videos/${firstBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key }),
  })).status, 409, "ready videos cannot be cancelled as pending uploads");
  assert.equal(provider.deleteAssetCalls, deletesBeforeTerminalCancel);

  const cancelRaceKey = `cancel-race-${suffix}`;
  const cancelRaceInit = await init(cancelRaceKey);
  const cancelRaceBody = await cancelRaceInit.json() as { videoId: string };
  const originalCancelRaceDelete = provider.deleteAsset.bind(provider);
  let releaseCancelDelete!: () => void;
  const cancelDeleteReleased = new Promise<void>((resolve) => { releaseCancelDelete = resolve; });
  let cancelDeletionClaimed!: () => void;
  const cancelDeletionStarted = new Promise<void>((resolve) => { cancelDeletionClaimed = resolve; });
  provider.deleteAsset = async (space, asset) => {
    cancelDeletionClaimed();
    await cancelDeleteReleased;
    return originalCancelRaceDelete(space, asset);
  };
  const racingCancel = fetch(`${base}/api/videos/${cancelRaceBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: cancelRaceKey }),
  });
  await cancelDeletionStarted;
  assert.equal((await fetch(`${base}/api/videos/${cancelRaceBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: cancelRaceKey }),
  })).status, 409, "completion must lose once cancellation owns the deletion claim");
  const deleteCallsDuringCancelRace = provider.deleteAssetCalls;
  assert.equal((await fetch(`${base}/api/videos/${cancelRaceBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: cancelRaceKey }),
  })).status, 409, "concurrent cancellation must not repeat provider deletion");
  assert.equal(provider.deleteAssetCalls, deleteCallsDuringCancelRace);
  releaseCancelDelete();
  assert.equal((await racingCancel).status, 200);
  provider.deleteAsset = originalCancelRaceDelete;

  const ambiguousCancelKey = `cancel-ambiguous-${suffix}`;
  const ambiguousCancelInit = await init(ambiguousCancelKey);
  const ambiguousCancelBody = await ambiguousCancelInit.json() as { videoId: string };
  provider.failNextDeleteAfterAcceptance = true;
  assert.equal((await fetch(`${base}/api/videos/${ambiguousCancelBody.videoId}/upload-cancel`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: ambiguousCancelKey }),
  })).status, 503);
  const [ambiguousCancellation] = await db.select().from(videosTable)
    .where(eq(videosTable.id, ambiguousCancelBody.videoId));
  assert.equal(ambiguousCancellation?.status, "error");
  assert.equal(ambiguousCancellation?.reconciliationRequired, "upload cancellation provider deletion outcome unknown");
  assert.equal(ambiguousCancellation?.quotaReleasedAt, null, "ambiguous cancellation must retain reserved quota");

  const expiredInit = await init(`expired-${suffix}`);
  const expiredBody = await expiredInit.json() as { videoId: string };
  await db.update(videosTable).set({ reservationExpiresAt: new Date(0) }).where(eq(videosTable.id, expiredBody.videoId));
  const cleanup = await cleanupExpiredUploads(async () => provider);
  assert.equal(cleanup.released, 1);
  assert.equal((await init(`expired-${suffix}`)).status, 409, "expired upload cannot be resurrected");

  const raceInit = await init(`expired-race-${suffix}`);
  const raceBody = await raceInit.json() as { videoId: string };
  await db.update(videosTable).set({ reservationExpiresAt: new Date(0) })
    .where(eq(videosTable.id, raceBody.videoId));
  const originalDelete = provider.deleteAsset.bind(provider);
  let releaseDelete!: () => void;
  const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let deletionClaimed!: () => void;
  const deletionStarted = new Promise<void>((resolve) => { deletionClaimed = resolve; });
  provider.deleteAsset = async (space, asset) => {
    deletionClaimed();
    await deleteReleased;
    return originalDelete(space, asset);
  };
  const racingCleanup = cleanupExpiredUploads(async () => provider);
  await deletionStarted;
  const racingComplete = await fetch(`${base}/api/videos/${raceBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `expired-race-${suffix}` }),
  });
  assert.equal(racingComplete.status, 409, "completion cannot acknowledge an asset claimed for expiry deletion");
  releaseDelete();
  assert.equal((await racingCleanup).released, 1);
  provider.deleteAsset = originalDelete;

  const completionWinsInit = await init(`completion-wins-${suffix}`);
  const completionWinsBody = await completionWinsInit.json() as { videoId: string };
  await db.update(videosTable).set({ reservationExpiresAt: new Date(0) })
    .where(eq(videosTable.id, completionWinsBody.videoId));
  assert.equal((await fetch(`${base}/api/videos/${completionWinsBody.videoId}/upload-complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `completion-wins-${suffix}` }),
  })).status, 200);
  const deletesBeforeCompletedCleanup = provider.deleteAssetCalls;
  assert.equal((await cleanupExpiredUploads(async () => provider)).released, 0);
  assert.equal(provider.deleteAssetCalls, deletesBeforeCompletedCleanup, "cleanup never deletes an acknowledged upload");

  const staleClaimInit = await init(`stale-cleanup-claim-${suffix}`);
  const staleClaimBody = await staleClaimInit.json() as { videoId: string };
  await db.update(videosTable).set({
    reservationExpiresAt: new Date(0),
    deletionClaim: randomUUID(),
    deletionClaimedAt: new Date(Date.now() - 16 * 60_000),
  }).where(eq(videosTable.id, staleClaimBody.videoId));
  await cleanupExpiredUploads(async () => provider);
  const [staleClaim] = await db.select().from(videosTable)
    .where(eq(videosTable.id, staleClaimBody.videoId));
  assert.equal(staleClaim?.status, "error");
  assert.equal(staleClaim?.reconciliationRequired, "expired upload provider deletion outcome unknown");

  const staleAssetInit = await init(`stale-asset-claim-${suffix}`);
  const staleAssetBody = await staleAssetInit.json() as { videoId: string };
  await db.update(videosTable).set({
    status: "created",
    providerAssetId: null,
    assetCreationClaim: randomUUID(),
    assetCreationClaimedAt: new Date(Date.now() - 16 * 60_000),
  }).where(eq(videosTable.id, staleAssetBody.videoId));
  const staleAssetCleanup = await cleanupExpiredUploads(async () => provider);
  assert.equal(staleAssetCleanup.reconciliationRequired >= 1, true);
  const [staleAsset] = await db.select().from(videosTable).where(eq(videosTable.id, staleAssetBody.videoId));
  assert.equal(staleAsset?.status, "error");
  assert.equal(staleAsset?.reconciliationRequired, "provider asset creation outcome unknown");

  const otherOrg = randomUUID();
  await db.insert(organizationsTable).values({ id: otherOrg, name: "Other", slug: `other-${suffix}`, status: "active", planId });
  const [foreignVideo] = await db.insert(videosTable).values({ organizationId: otherOrg, title: "Foreign" }).returning();
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role vid_app"));
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    const rows = await tx.select().from(videosTable).where(eq(videosTable.id, foreignVideo.id));
    assert.equal(rows.length, 0, "cross-tenant read must be hidden");
    const changed = await tx.update(videosTable).set({ title: "Denied" }).where(eq(videosTable.id, foreignVideo.id)).returning();
    assert.equal(changed.length, 0, "cross-tenant write must be denied");
  });
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrg));
  console.info(JSON.stringify({ ok: true, providerCreateCalls: provider.createAssetCalls, cleanup }));
} finally {
  setBeforeAssetCreationClaimForTest(undefined);
  server.close();
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId)).catch(() => undefined);
  await db.delete(providerAccountsTable).where(eq(providerAccountsTable.id, accountId)).catch(() => undefined);
  await db.delete(plansTable).where(eq(plansTable.id, planId)).catch(() => undefined);
  await db.delete(usersTable).where(eq(usersTable.email, email)).catch(() => undefined);
}