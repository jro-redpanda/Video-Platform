import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  billingEventReceiptsTable,
  organizationBillingTable,
} from "@workspace/db";
import { getStripeSync } from "./stripe-client";
import {
  isBillingIntegrityError,
  reconcileOrganizationBilling,
} from "./billing-reconciliation";
import { withWorkerDb } from "./worker-db";

type VerifiedStripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

const relevantEvent = /^(checkout\.session|customer\.subscription|invoice)\./;
const eventId = /^evt_[A-Za-z0-9_]{1,180}$/;
const eventType = /^[a-z][a-z0-9_.]{1,120}$/;
const receiptLeaseMs = 5 * 60_000;
const bindingWindowMs = 24 * 60 * 60_000;

function providerId(value: unknown) {
  if (typeof value === "string" && value.length > 2 && value.length <= 200) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 2 && id.length <= 200) return id;
  }
  return undefined;
}

export function parseVerifiedStripeEvent(payload: Buffer): VerifiedStripeEvent {
  let value: unknown;
  try { value = JSON.parse(payload.toString("utf8")); } catch { throw new Error("stripe_event_payload_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stripe_event_payload_invalid");
  const item = value as Partial<VerifiedStripeEvent>;
  if (!item.id || !eventId.test(item.id) || !item.type || !eventType.test(item.type)
    || !Number.isSafeInteger(item.created) || item.created! < 0
    || !item.data || typeof item.data !== "object" || !item.data.object
    || typeof item.data.object !== "object" || Array.isArray(item.data.object)) {
    throw new Error("stripe_event_payload_invalid");
  }
  return item as VerifiedStripeEvent;
}

function eventBindings(event: VerifiedStripeEvent) {
  const object = event.data.object;
  return {
    objectId: providerId(object.id),
    customerId: providerId(object.customer),
    subscriptionId: event.type.startsWith("customer.subscription.")
      ? providerId(object.id)
      : providerId(object.subscription),
    checkoutSessionId: event.type.startsWith("checkout.session.") ? providerId(object.id) : undefined,
  };
}

async function claimVerifiedEvent(event: VerifiedStripeEvent) {
  const bindings = eventBindings(event);
  const claimToken = randomUUID();
  return withWorkerDb("billing", async (tx) => {
    await tx.insert(billingEventReceiptsTable).values({
      stripeEventId: event.id,
      stripeObjectId: bindings.objectId ?? null,
      stripeCustomerId: bindings.customerId ?? null,
      stripeSubscriptionId: bindings.subscriptionId ?? null,
      stripeCheckoutSessionId: bindings.checkoutSessionId ?? null,
      stripeObjectVersion: String(event.created),
      eventType: event.type,
    }).onConflictDoNothing();
    const [receipt] = await tx.select().from(billingEventReceiptsTable)
      .where(eq(billingEventReceiptsTable.stripeEventId, event.id))
      .for("update")
      .limit(1);
    if (!receipt) throw new Error("stripe_event_receipt_missing");
    if (receipt.eventType !== event.type
      || receipt.stripeObjectId !== (bindings.objectId ?? null)
      || receipt.stripeCustomerId !== (bindings.customerId ?? null)
      || receipt.stripeSubscriptionId !== (bindings.subscriptionId ?? null)
      || receipt.stripeCheckoutSessionId !== (bindings.checkoutSessionId ?? null)
      || receipt.stripeObjectVersion !== String(event.created)) {
      await tx.update(billingEventReceiptsTable).set({
        processingState: "quarantined",
        diagnosticCode: "stripe_event_receipt_conflict",
        processingClaim: null,
        processingClaimedAt: null,
        processedAt: new Date(),
      }).where(eq(billingEventReceiptsTable.id, receipt.id));
      return undefined;
    }
    if (receipt.processingState === "processed" || receipt.processingState === "ignored"
      || receipt.processingState === "quarantined") return undefined;
    if (receipt.processingState === "processing" && receipt.processingClaimedAt
      && receipt.processingClaimedAt.getTime() > Date.now() - receiptLeaseMs) return undefined;

    const conditions: SQL[] = [];
    if (bindings.subscriptionId) conditions.push(eq(organizationBillingTable.stripeSubscriptionId, bindings.subscriptionId));
    if (bindings.customerId) conditions.push(eq(organizationBillingTable.stripeCustomerId, bindings.customerId));
    if (bindings.checkoutSessionId) conditions.push(eq(organizationBillingTable.pendingCheckoutSessionId, bindings.checkoutSessionId));
    const matches = conditions.length
      ? await tx.select({ organizationId: organizationBillingTable.organizationId })
        .from(organizationBillingTable).where(or(...conditions))
      : [];
    const organizations = [...new Set(matches.map((match) => match.organizationId))];
    if (organizations.length > 1
      || (receipt.organizationId && organizations[0] !== receipt.organizationId)) {
      await tx.update(billingEventReceiptsTable).set({
        processingState: "quarantined",
        diagnosticCode: receipt.organizationId
          ? "stripe_event_binding_changed"
          : "stripe_event_binding_ambiguous",
        processingClaim: null,
        processingClaimedAt: null,
        processedAt: new Date(),
      }).where(eq(billingEventReceiptsTable.id, receipt.id));
      return undefined;
    }
    if (!organizations.length) {
      const expired = receipt.receivedAt.getTime() <= Date.now() - bindingWindowMs;
      await tx.update(billingEventReceiptsTable).set({
        processingState: expired ? "ignored" : "binding_pending",
        diagnosticCode: expired ? "stripe_event_binding_expired" : "stripe_event_binding_pending",
        processingClaim: null,
        processingClaimedAt: null,
        attempts: sql`${billingEventReceiptsTable.attempts} + 1`,
        processedAt: expired ? new Date() : null,
      }).where(eq(billingEventReceiptsTable.id, receipt.id));
      return expired ? undefined : { bindingPending: true as const };
    }
    const organizationId = organizations[0]!;
    await tx.update(billingEventReceiptsTable).set({
      organizationId,
      processingState: "processing",
      processingClaim: claimToken,
      processingClaimedAt: new Date(),
      attempts: sql`${billingEventReceiptsTable.attempts} + 1`,
      diagnosticCode: null,
      processedAt: null,
    }).where(eq(billingEventReceiptsTable.id, receipt.id));
    return { receiptId: receipt.id, organizationId, claimToken };
  });
}

async function finishVerifiedEvent(
  receiptId: string,
  organizationId: string,
  claimToken: string,
  event: VerifiedStripeEvent,
  state: "processed" | "failed" | "quarantined",
  diagnosticCode: string | null,
) {
  await withWorkerDb("billing", async (tx) => {
    const [finished] = await tx.update(billingEventReceiptsTable).set({
      processingState: state,
      processingClaim: null,
      processingClaimedAt: null,
      diagnosticCode,
      processedAt: state === "failed" ? null : new Date(),
    }).where(and(
      eq(billingEventReceiptsTable.id, receiptId),
      eq(billingEventReceiptsTable.organizationId, organizationId),
      eq(billingEventReceiptsTable.processingState, "processing"),
      eq(billingEventReceiptsTable.processingClaim, claimToken),
    )).returning({ id: billingEventReceiptsTable.id });
    if (!finished || state !== "processed") return;
    const [billing] = await tx.select({
      lastVersion: organizationBillingTable.lastStripeObjectVersion,
    }).from(organizationBillingTable)
      .where(eq(organizationBillingTable.organizationId, organizationId))
      .for("update")
      .limit(1);
    const lastVersion = billing?.lastVersion && /^\d+$/.test(billing.lastVersion)
      ? Number(billing.lastVersion) : -1;
    if (event.created >= lastVersion) await tx.update(organizationBillingTable).set({
      lastStripeEventId: event.id,
      lastStripeObjectVersion: String(event.created),
      updatedAt: new Date(),
    }).where(and(
      eq(organizationBillingTable.organizationId, organizationId),
      billing?.lastVersion === null
        ? isNull(organizationBillingTable.lastStripeObjectVersion)
        : eq(organizationBillingTable.lastStripeObjectVersion, billing?.lastVersion ?? ""),
    ));
  });
}

export async function processVerifiedStripeEvent(event: VerifiedStripeEvent) {
  if (!relevantEvent.test(event.type)) return;
  const claim = await claimVerifiedEvent(event);
  if (!claim) return;
  if ("bindingPending" in claim) throw new Error("stripe_event_binding_pending");
  try {
    await reconcileOrganizationBilling(claim.organizationId);
    await finishVerifiedEvent(
      claim.receiptId,
      claim.organizationId,
      claim.claimToken,
      event,
      "processed",
      null,
    );
  } catch (error) {
    const integrityFailure = isBillingIntegrityError(error);
    await finishVerifiedEvent(
      claim.receiptId,
      claim.organizationId,
      claim.claimToken,
      event,
      integrityFailure ? "quarantined" : "failed",
      integrityFailure ? error.code : "billing_reconciliation_retryable",
    );
    if (!integrityFailure) throw error;
  }
}

async function claimPendingReceipt(receiptId: string) {
  const claimToken = randomUUID();
  return withWorkerDb("billing", async (tx) => {
    const [receipt] = await tx.select().from(billingEventReceiptsTable)
      .where(eq(billingEventReceiptsTable.id, receiptId))
      .for("update")
      .limit(1);
    if (!receipt || receipt.processingState === "processed" || receipt.processingState === "ignored"
      || receipt.processingState === "quarantined") return undefined;
    if (receipt.processingState === "processing" && receipt.processingClaimedAt
      && receipt.processingClaimedAt.getTime() > Date.now() - receiptLeaseMs) return undefined;

    let organizationId = receipt.organizationId;
    const conditions: SQL[] = [];
    if (receipt.stripeSubscriptionId) {
      conditions.push(eq(organizationBillingTable.stripeSubscriptionId, receipt.stripeSubscriptionId));
    }
    if (receipt.stripeCustomerId) {
      conditions.push(eq(organizationBillingTable.stripeCustomerId, receipt.stripeCustomerId));
    }
    if (receipt.stripeCheckoutSessionId) {
      conditions.push(eq(organizationBillingTable.pendingCheckoutSessionId, receipt.stripeCheckoutSessionId));
    }
    if (conditions.length) {
      const matches = await tx.select({ organizationId: organizationBillingTable.organizationId })
        .from(organizationBillingTable).where(or(...conditions));
      const organizations = [...new Set(matches.map((match) => match.organizationId))];
      const bindingChanged = organizationId
        ? organizations.length !== 1 || organizations[0] !== organizationId
        : organizations.length > 1;
      if (bindingChanged) {
        await tx.update(billingEventReceiptsTable).set({
          processingState: "quarantined",
          diagnosticCode: organizationId
            ? "stripe_event_binding_changed"
            : "stripe_event_binding_ambiguous",
          processingClaim: null,
          processingClaimedAt: null,
          processedAt: new Date(),
        }).where(eq(billingEventReceiptsTable.id, receipt.id));
        return undefined;
      }
      organizationId ??= organizations[0] ?? null;
    } else if (organizationId) {
      await tx.update(billingEventReceiptsTable).set({
        processingState: "quarantined",
        diagnosticCode: "stripe_event_binding_changed",
        processingClaim: null,
        processingClaimedAt: null,
        processedAt: new Date(),
      }).where(eq(billingEventReceiptsTable.id, receipt.id));
      return undefined;
    }
    if (!organizationId) {
      const expired = receipt.receivedAt.getTime() <= Date.now() - bindingWindowMs;
      if (expired) await tx.update(billingEventReceiptsTable).set({
        processingState: "ignored",
        diagnosticCode: "stripe_event_binding_expired",
        processingClaim: null,
        processingClaimedAt: null,
        processedAt: new Date(),
      }).where(eq(billingEventReceiptsTable.id, receipt.id));
      return undefined;
    }
    await tx.update(billingEventReceiptsTable).set({
      organizationId,
      processingState: "processing",
      processingClaim: claimToken,
      processingClaimedAt: new Date(),
      attempts: sql`${billingEventReceiptsTable.attempts} + 1`,
      diagnosticCode: null,
      processedAt: null,
    }).where(eq(billingEventReceiptsTable.id, receipt.id));
    return {
      receiptId: receipt.id,
      organizationId,
      claimToken,
      event: {
        id: receipt.stripeEventId,
        type: receipt.eventType,
        created: /^\d+$/.test(receipt.stripeObjectVersion ?? "")
          ? Number(receipt.stripeObjectVersion)
          : 0,
        data: { object: {} },
      } satisfies VerifiedStripeEvent,
    };
  });
}

export async function reconcilePendingBillingReceipts(limit = 100) {
  const staleClaim = new Date(Date.now() - receiptLeaseMs);
  const rows = await withWorkerDb("billing", (tx) =>
    tx.select({ id: billingEventReceiptsTable.id }).from(billingEventReceiptsTable)
      .where(or(
        eq(billingEventReceiptsTable.processingState, "binding_pending"),
        eq(billingEventReceiptsTable.processingState, "failed"),
        and(
          eq(billingEventReceiptsTable.processingState, "processing"),
          or(
            isNull(billingEventReceiptsTable.processingClaimedAt),
            lt(billingEventReceiptsTable.processingClaimedAt, staleClaim),
          ),
        ),
      ))
      .limit(limit));
  let reconciled = 0;
  let retryableFailures = 0;
  for (const row of rows) {
    const claim = await claimPendingReceipt(row.id);
    if (!claim) continue;
    try {
      await reconcileOrganizationBilling(claim.organizationId);
      await finishVerifiedEvent(
        claim.receiptId,
        claim.organizationId,
        claim.claimToken,
        claim.event,
        "processed",
        null,
      );
      reconciled++;
    } catch (error) {
      const integrityFailure = isBillingIntegrityError(error);
      await finishVerifiedEvent(
        claim.receiptId,
        claim.organizationId,
        claim.claimToken,
        claim.event,
        integrityFailure ? "quarantined" : "failed",
        integrityFailure ? error.code : "billing_reconciliation_retryable",
      );
      if (!integrityFailure) retryableFailures++;
    }
  }
  if (retryableFailures) throw new Error("billing_receipt_reconciliation_retryable");
  return { reconciled };
}

export async function processStripeWebhook(payload: Buffer, signature: string) {
  if (!Buffer.isBuffer(payload)) throw new Error("Stripe webhook payload must be a raw Buffer");
  await (await getStripeSync()).processWebhook(payload, signature);
  await processVerifiedStripeEvent(parseVerifiedStripeEvent(payload));
}