import { and, eq, isNotNull, or } from "drizzle-orm";
import {
  organizationBillingTable, organizationsTable, plansTable,
} from "@workspace/db";
import { billingProvider, type ProviderSubscription } from "./billing-provider";
import { withBillingLifecycleLock } from "./billing-lifecycle-lock";
import { auditJob, auditUser, writeAuditEvent } from "./audit";
import { withOrganizationDb } from "./tenant-db";
import { withWorkerDb } from "./worker-db";

const granting = new Set(["active", "trialing"]);
const accepted = new Set(["incomplete", "incomplete_expired", "active", "trialing", "past_due", "unpaid", "canceled", "paused"]);

export class BillingIntegrityError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function isBillingIntegrityError(error: unknown): error is BillingIntegrityError {
  return error instanceof BillingIntegrityError;
}

function subscriptionPeriod(subscription: ProviderSubscription) {
  if (!subscription.items || !Array.isArray(subscription.items.data) || subscription.items.data.length !== 1) {
    throw new BillingIntegrityError("subscription_item_count_ambiguous");
  }
  const item = subscription.items.data[0] as typeof subscription.items.data[number] & {
    current_period_start?: number; current_period_end?: number;
  };
  if (!item.current_period_start || !item.current_period_end) {
    throw new BillingIntegrityError("subscription_period_missing");
  }
  return { start: new Date(item.current_period_start * 1000), end: new Date(item.current_period_end * 1000), priceId: item.price.id };
}

function providerResourceMissing(error: unknown) {
  return typeof error === "object" && error !== null
    && "code" in error && (error as { code?: unknown }).code === "resource_missing";
}

/** Must only be called while holding this organization's lifecycle lock. */
export async function reconcileOrganizationBillingUnderLock(organizationId: string, actorUserId?: string) {
  const transaction = actorUserId
    ? <T>(operation: Parameters<typeof withOrganizationDb<T>>[1]) => withOrganizationDb(organizationId, operation)
    : <T>(operation: Parameters<typeof withWorkerDb<T>>[1]) => withWorkerDb("billing", operation);
  const outcome = await transaction(async (tx) => {
  let [snapshot] = await tx.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId)).limit(1);
  if (!snapshot) return { snapshot };
  try {
    if (!snapshot.stripeSubscriptionId && snapshot.pendingCheckoutExpiresAt && snapshot.pendingCheckoutExpiresAt <= new Date()) {
      [snapshot] = await tx.update(organizationBillingTable).set({
        pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
        pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null, updatedAt: new Date(),
      }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
    }
    let subscriptionId = snapshot.stripeSubscriptionId;
    if (!subscriptionId) {
      if (!snapshot.stripeCustomerId) return { snapshot };
      const candidates = (await billingProvider().listSubscriptions(snapshot.stripeCustomerId))
        .filter((item) => item.status !== "canceled");
      if (!candidates.length) return { snapshot };
      if (candidates.length !== 1) throw new BillingIntegrityError("stripe_subscription_count_ambiguous");
      subscriptionId = candidates[0]!.id;
    }
    let subscription: ProviderSubscription;
    try {
      subscription = await billingProvider().retrieveSubscription(subscriptionId);
    } catch (error) {
      if (providerResourceMissing(error)) throw new BillingIntegrityError("stripe_subscription_missing");
      throw error;
    }
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    if (customerId !== snapshot.stripeCustomerId || subscription.metadata.organization_id !== organizationId) {
      throw new BillingIntegrityError("stripe_customer_organization_mismatch");
    }
    if (!accepted.has(subscription.status)) throw new BillingIntegrityError("stripe_subscription_status_ambiguous");
    const period = subscriptionPeriod(subscription);
    const [plan] = await tx.select().from(plansTable).where(and(
      eq(plansTable.active, true),
      or(eq(plansTable.stripeMonthlyPriceId, period.priceId), eq(plansTable.stripeAnnualPriceId, period.priceId)),
    )).limit(1);
    if (!plan) throw new BillingIntegrityError("stripe_price_unknown");
    const interval = plan.stripeMonthlyPriceId === period.priceId ? "month" as const : "year" as const;
    const now = new Date();
    const previousStatus = snapshot.status;
    const providerScheduleId = typeof subscription.schedule === "string"
      ? subscription.schedule
      : subscription.schedule?.id ?? null;
    const pendingPlanReached = snapshot.pendingPlanId === plan.id;
    const pendingScheduleLost = Boolean(
      snapshot.pendingPlanId
      && snapshot.pendingSubscriptionScheduleId
      && !pendingPlanReached
      && providerScheduleId !== snapshot.pendingSubscriptionScheduleId,
    );
    const providerStatus = subscription.status as NonNullable<typeof snapshot.stripeSubscriptionStatus>;
    const graceEndsAt = providerStatus === "past_due"
      ? snapshot.graceEndsAt ?? new Date(now.getTime() + 7 * 86400_000) : null;
    const restricted = !granting.has(providerStatus) &&
      !(providerStatus === "past_due" && graceEndsAt !== null && graceEndsAt > now) &&
      (providerStatus === "unpaid" || providerStatus === "canceled" || providerStatus === "past_due" ||
       providerStatus === "incomplete_expired" || providerStatus === "paused");
    const status = restricted ? "restricted" as const : providerStatus as Exclude<typeof providerStatus, "incomplete_expired" | "paused">;
    const [updated] = await (async () => {
      const [row] = await tx.update(organizationBillingTable).set({
        stripeSubscriptionId: subscription.id,
        status, interval, currentPlanId: plan.id, stripeSubscriptionStatus: providerStatus,
        periodStart: period.start, periodEnd: period.end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        ...(pendingPlanReached || pendingScheduleLost ? {
          pendingPlanId: null,
          pendingEffectiveAt: null,
          pendingSubscriptionScheduleId: null,
        } : {}),
        // subscription.created is immutable creation time, never an update version.
        pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
        pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null,
        graceEndsAt,
        lastReconciledAt: now,
        lastErrorCode: pendingScheduleLost ? "stripe_downgrade_schedule_missing" : null,
        updatedAt: now,
      }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
      if (granting.has(status) || status === "past_due") {
        await tx.update(organizationsTable).set({ planId: plan.id }).where(eq(organizationsTable.id, organizationId));
      }
       if (previousStatus !== status) await writeAuditEvent(tx, {
         organizationId,
         actor: actorUserId ? auditUser(actorUserId) : auditJob(),
         action: "billing.status_changed", category: "billing",
         // Provider subscription IDs are not audit subjects; the tenant's
         // billing projection is the durable state that changed.
         subject: { type: "billing", id: organizationId, label: status },
         beforeState: { status: previousStatus }, afterState: { status, providerStatus },
       });
       if (pendingScheduleLost) await writeAuditEvent(tx, {
         organizationId,
         actor: actorUserId ? auditUser(actorUserId) : auditJob(),
         action: "billing.downgrade_schedule_cleared",
         category: "billing",
         subject: { type: "billing", id: organizationId, label: "downgrade" },
         beforeState: { pending: true },
         afterState: { pending: false },
         metadata: { code: "stripe_downgrade_schedule_missing" },
       });
      return [row];
    })();
    return { snapshot: updated };
  } catch (error) {
    const integrityFailure = isBillingIntegrityError(error);
    const code = integrityFailure ? error.code : "billing_reconciliation_retryable";
    const [failedSnapshot] = await tx.update(organizationBillingTable).set({
      ...(integrityFailure ? { status: "quarantined" as const } : {}),
      lastErrorCode: code, lastReconciledAt: new Date(), updatedAt: new Date(),
    }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
    if (integrityFailure || snapshot.lastErrorCode !== code) await writeAuditEvent(tx, {
      organizationId, actor: actorUserId ? auditUser(actorUserId) : auditJob(),
      action: integrityFailure ? "billing.reconciliation.failed" : "billing.reconciliation.deferred",
      category: "billing",
      subject: { type: "billing", id: organizationId, label: integrityFailure ? "quarantined" : snapshot.status },
      beforeState: { status: snapshot.status },
      afterState: { status: integrityFailure ? "quarantined" : snapshot.status },
      metadata: { code },
    });
    return { snapshot: failedSnapshot ?? snapshot, error };
  }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.snapshot;
}

export async function reconcileOrganizationBilling(organizationId: string, actorUserId?: string) {
  return withBillingLifecycleLock(
    organizationId,
    () => reconcileOrganizationBillingUnderLock(organizationId, actorUserId),
  );
}

export async function reconcileActiveBilling(limit = 100, testOrganizationId?: string) {
  if (testOrganizationId && process.env.NODE_ENV !== "test") {
    throw new Error("Billing reconciliation organization filter is test-only");
  }
  const rows = await withWorkerDb("billing", (tx) =>
    tx.select({ organizationId: organizationBillingTable.organizationId })
      .from(organizationBillingTable).where(and(
        isNotNull(organizationBillingTable.stripeCustomerId),
        testOrganizationId ? eq(organizationBillingTable.organizationId, testOrganizationId) : undefined,
        or(
          eq(organizationBillingTable.status, "unmanaged"),
          eq(organizationBillingTable.status, "incomplete"),
          eq(organizationBillingTable.status, "active"),
          eq(organizationBillingTable.status, "trialing"),
          eq(organizationBillingTable.status, "past_due"),
          eq(organizationBillingTable.status, "unpaid"),
          eq(organizationBillingTable.status, "canceled"),
          eq(organizationBillingTable.status, "restricted"),
        ),
      )).limit(limit));
  let reconciled = 0;
  let retryableFailures = 0;
  for (const row of rows) {
    try {
      await reconcileOrganizationBilling(row.organizationId);
      reconciled++;
    } catch (error) {
      if (!isBillingIntegrityError(error)) retryableFailures++;
    }
  }
  if (retryableFailures) throw new Error("billing_reconciliation_retryable");
  return { reconciled };
}