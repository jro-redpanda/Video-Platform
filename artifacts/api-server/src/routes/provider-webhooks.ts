import { createHash } from "node:crypto";
import express, { Router, type IRouter, type Request } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  providerAccountsTable,
  providerTenantSpacesTable,
  videosTable,
  webhookEventsTable,
  embedGenerationOutboxTable,
} from "@workspace/db";
import {
  inspectBunnyEncodeCompletionCallback,
  type EncodeCompletionEvent,
  type VideoProvider,
} from "@workspace/providers";
import { resolveBunnyWebhookProvider } from "../lib/provider-registry";
import { enqueueEmbedDispatchWakeup } from "../lib/jobs";
import { auditWebhook, writeAuditEvent } from "../lib/audit";

const router: IRouter = Router();

router.post("/webhooks/bunny/encode", express.raw({ type: "application/json", limit: "64kb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    return void res.status(400).json({ error: "Malformed webhook body" });
  }
  const rawBody = req.body;
  let tenantSpaceId: string;
  try {
    tenantSpaceId = inspectBunnyEncodeCompletionCallback(rawBody).tenantSpaceId;
  } catch {
    return void res.status(400).json({ error: "Malformed webhook body" });
  }

  const candidates = await db.select({ account: providerAccountsTable, space: providerTenantSpacesTable })
    .from(providerTenantSpacesTable)
    .innerJoin(
      providerAccountsTable,
      eq(providerAccountsTable.id, providerTenantSpacesTable.providerAccountId),
    )
    .where(and(
      eq(providerAccountsTable.providerKey, "bunny"),
      eq(providerTenantSpacesTable.providerSpaceId, tenantSpaceId),
      eq(providerTenantSpacesTable.state, "created"),
    ));

  const verified: Array<{
    account: typeof providerAccountsTable.$inferSelect;
    space: typeof providerTenantSpacesTable.$inferSelect;
    event: EncodeCompletionEvent;
  }> = [];
  let providerResolutionFailed = false;
  for (const candidate of candidates) {
    let provider: VideoProvider;
    try {
      provider = await resolveBunnyWebhookProvider(candidate.account, candidate.space);
    } catch {
      providerResolutionFailed = true;
      continue;
    }
    const event = provider.verifyEncodeCompletionCallback(rawBody, req.headers);
    if (event) verified.push({ ...candidate, event });
  }

  if (verified.length !== 1) {
    if (verified.length === 0 && providerResolutionFailed) {
      return void res.status(503).json({ error: "Webhook verification is temporarily unavailable" });
    }
    if (candidates.length === 1) {
      await recordRejectedReceipt(candidates[0]!.account.id, tenantSpaceId, rawBody, req);
    }
    return void res.status(verified.length > 1 ? 403 : 401).json({ error: "Webhook verification failed" });
  }

  const selected = verified[0]!;
  const outcome = await processVerifiedEvent(selected.account.id, selected.space, selected.event, rawBody);
  if (outcome.wakeDispatcher) {
    // This is only an optimization: the durable outbox schedule repairs failures.
    await enqueueEmbedDispatchWakeup().catch(() => undefined);
  }
  res.status(202).json({ accepted: true });
});

async function processVerifiedEvent(
  providerAccountId: string,
  space: typeof providerTenantSpacesTable.$inferSelect,
  event: EncodeCompletionEvent,
  rawBody: Buffer,
) {
  const receiptDigest = digest(`${providerAccountId}:${digest(rawBody)}`);
  return db.transaction(async (tx) => {
    const [receipt] = await tx.insert(webhookEventsTable).values({
      providerKey: "bunny",
      receiptDigest,
      providerEventId: event.eventId,
      providerAccountId,
      providerTenantSpaceId: event.tenantSpaceId,
      providerAssetId: event.assetId,
      verificationState: "verified",
      processingState: "claimed",
      signatureValid: true,
      payload: {},
      verifiedAt: new Date(),
      claimedAt: new Date(),
    }).onConflictDoNothing().returning({ id: webhookEventsTable.id });

    // The original transaction owns all processing and queue intent.
    if (!receipt) {
      const [existing] = await tx.select({
        ownedVideoId: webhookEventsTable.ownedVideoId,
        processingState: webhookEventsTable.processingState,
        diagnosticCode: webhookEventsTable.diagnosticCode,
        embedEnqueuedAt: webhookEventsTable.embedEnqueuedAt,
      }).from(webhookEventsTable).where(and(
        eq(webhookEventsTable.providerKey, "bunny"),
        eq(webhookEventsTable.receiptDigest, receiptDigest),
      )).limit(1);
      return {
        receiptDigest,
        wakeDispatcher: existing?.processingState === "processed"
          && existing.diagnosticCode === null
          && existing.embedEnqueuedAt === null,
      };
    }

    const matches = await tx.select({
      id: videosTable.id,
      organizationId: videosTable.organizationId,
      status: videosTable.status,
      title: videosTable.title,
    }).from(videosTable).where(and(
      eq(videosTable.providerAccountId, providerAccountId),
      eq(videosTable.providerTenantSpaceId, event.tenantSpaceId),
      eq(videosTable.providerAssetId, event.assetId),
      eq(videosTable.organizationId, space.organizationId),
    )).limit(2);

    if (matches.length !== 1) {
      await tx.update(webhookEventsTable).set({
        processingState: "ignored",
        diagnosticCode: matches.length ? "ambiguous_asset_linkage" : "unknown_asset",
        processedAt: new Date(),
      }).where(eq(webhookEventsTable.id, receipt.id));
      return { receiptDigest };
    }

    const video = matches[0]!;
    const update = event.status.state === "ready"
      ? {
          status: "ready" as const,
          ...(event.status.durationSeconds > 0
            ? { durationSeconds: Math.round(event.status.durationSeconds) }
            : {}),
          uploadFailureDetail: null,
        }
      : {
          status: "error" as const,
          uploadFailureDetail: "provider_encode_failed",
        };
    const changed = await tx.update(videosTable).set(update).where(and(
      eq(videosTable.id, video.id),
      inArray(videosTable.status, ["uploading", "processing"]),
      isNull(videosTable.deletionClaim),
      isNull(videosTable.reconciliationRequired),
    )).returning({ id: videosTable.id });

    await tx.update(webhookEventsTable).set({
      organizationId: video.organizationId,
      ownedVideoId: video.id,
      processingState: changed.length ? "processed" : "ignored",
      diagnosticCode: changed.length
        ? event.status.state === "ready" ? null : "embed_not_applicable"
        : "terminal_state_noop",
      processedAt: new Date(),
    }).where(eq(webhookEventsTable.id, receipt.id));
    if (changed.length) await writeAuditEvent(tx, {
      organizationId: video.organizationId, actor: auditWebhook(),
      action: "provider.bunny.encode_status_changed", category: "provider",
      subject: { type: "video", id: video.id, label: video.title },
      beforeState: { status: video.status },
      afterState: { status: update.status },
      metadata: { provider: "bunny" }, requestId: undefined,
    });

    if (changed.length && event.status.state === "ready") {
      await tx.insert(embedGenerationOutboxTable).values({
        webhookEventId: receipt.id,
        videoId: video.id,
        state: "pending",
      }).onConflictDoNothing();
    }
    return { receiptDigest, wakeDispatcher: changed.length && event.status.state === "ready" };
  });
}

async function recordRejectedReceipt(
  providerAccountId: string,
  tenantSpaceId: string,
  rawBody: Buffer,
  req: Request,
) {
  const signature = firstHeader(req, "x-bunnystream-signature") ?? "missing";
  const receiptDigest = digest(`${providerAccountId}:${digest(rawBody)}:${signature}`);
  await db.insert(webhookEventsTable).values({
    providerKey: "bunny",
    receiptDigest,
    providerEventId: receiptDigest,
    providerAccountId,
    providerTenantSpaceId: tenantSpaceId,
    verificationState: "rejected",
    processingState: "ignored",
    signatureValid: false,
    payload: {},
    diagnosticCode: "invalid_signature",
    processedAt: new Date(),
  }).onConflictDoNothing();
}

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function firstHeader(req: Request, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export default router;