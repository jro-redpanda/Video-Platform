import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  db, organizationBillingTable, organizationsTable, plansTable,
} from "@workspace/db";
import { billingProvider, type ProviderSubscription } from "./billing-provider";
import { billingLifecycleLockKey } from "./billing-lifecycle-lock";
import { auditJob, auditUser, writeAuditEvent } from "./audit";

const granting = new Set(["active", "trialing"]);
const accepted = new Set(["incomplete", "incomplete_expired", "active", "trialing", "past_due", "unpaid", "canceled", "paused"]);

function subscriptionPeriod(subscription: ProviderSubscription) {
  if (subscription.items.data.length !== 1) throw new Error("subscription_item_count_ambiguous");
  const item = subscription.items.data[0] as typeof subscription.items.data[number] & {
    current_period_start?: number; current_period_end?: number;
  };
  if (!item.current_period_start || !item.current_period_end) throw new Error("subscription_period_missing");
  return { start: new Date(item.current_period_start * 1000), end: new Date(item.current_period_end * 1000), priceId: item.price.id };
}

export async function reconcileOrganizationBilling(organizationId: string, actorUserId?: string) {
  // This transaction-scoped lock spans provider retrieve and projection apply. It
  // serializes webhook, owner, and worker paths for this tenant only.
  return db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${billingLifecycleLockKey(organizationId)}))`);
  let [snapshot] = await tx.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId)).limit(1);
  if (!snapshot) return snapshot;
  try {
    if (!snapshot.stripeSubscriptionId && snapshot.pendingCheckoutExpiresAt && snapshot.pendingCheckoutExpiresAt <= new Date()) {
      [snapshot] = await tx.update(organizationBillingTable).set({
        pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
        pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null, updatedAt: new Date(),
      }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
    }
    if (!snapshot.stripeSubscriptionId) {
      if (!snapshot.stripeCustomerId) return snapshot;
      const candidates = (await billingProvider().listSubscriptions(snapshot.stripeCustomerId))
        .filter((item) => item.status !== "canceled");
      if (!candidates.length) return snapshot;
      if (candidates.length !== 1) throw new Error("stripe_subscription_count_ambiguous");
      [snapshot] = await tx.update(organizationBillingTable).set({
        stripeSubscriptionId: candidates[0]!.id,
        stripeSubscriptionStatus: candidates[0]!.status as typeof snapshot.stripeSubscriptionStatus,
        updatedAt: new Date(),
      }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
    }
    const subscription = await billingProvider().retrieveSubscription(snapshot.stripeSubscriptionId!);
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    if (customerId !== snapshot.stripeCustomerId || subscription.metadata.organization_id !== organizationId) {
      throw new Error("stripe_customer_organization_mismatch");
    }
    if (!accepted.has(subscription.status)) throw new Error("stripe_subscription_status_ambiguous");
    const period = subscriptionPeriod(subscription);
    const [plan] = await tx.select().from(plansTable).where(and(
      eq(plansTable.active, true),
      or(eq(plansTable.stripeMonthlyPriceId, period.priceId), eq(plansTable.stripeAnnualPriceId, period.priceId)),
    )).limit(1);
    if (!plan) throw new Error("stripe_price_unknown");
    const interval = plan.stripeMonthlyPriceId === period.priceId ? "month" as const : "year" as const;
    const now = new Date();
    const previousStatus = snapshot.status;
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
        status, interval, currentPlanId: plan.id, stripeSubscriptionStatus: providerStatus,
        periodStart: period.start, periodEnd: period.end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        ...(snapshot.pendingPlanId === plan.id ? { pendingPlanId: null, pendingEffectiveAt: null } : {}),
        // subscription.created is immutable creation time, never an update version.
        pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
        pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null,
        graceEndsAt, lastStripeObjectVersion: null,
        lastReconciledAt: now, lastErrorCode: null, updatedAt: now,
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
      return [row];
    })();
    return updated;
  } catch (error) {
    const code = "billing_reconciliation_failed";
    await tx.update(organizationBillingTable).set({
      status: "quarantined", lastErrorCode: code, lastReconciledAt: new Date(), updatedAt: new Date(),
    }).where(eq(organizationBillingTable.organizationId, organizationId));
    await writeAuditEvent(tx, {
      organizationId, actor: actorUserId ? auditUser(actorUserId) : auditJob(),
      action: "billing.reconciliation.failed", category: "billing",
      subject: { type: "billing", id: organizationId, label: "quarantined" },
      beforeState: { status: snapshot.status }, afterState: { status: "quarantined" }, metadata: { code },
    });
    throw error;
  }
  });
}

export async function reconcileActiveBilling(limit = 100) {
  const rows = await db.select({ organizationId: organizationBillingTable.organizationId })
    .from(organizationBillingTable).where(and(isNotNull(organizationBillingTable.stripeCustomerId), or(
      eq(organizationBillingTable.status, "unmanaged"),
      eq(organizationBillingTable.status, "incomplete"),
      eq(organizationBillingTable.status, "active"),
      eq(organizationBillingTable.status, "trialing"),
      eq(organizationBillingTable.status, "past_due"),
      eq(organizationBillingTable.status, "unpaid"),
      eq(organizationBillingTable.status, "canceled"),
    ))).limit(limit);
  let reconciled = 0;
  for (const row of rows) {
    try { await reconcileOrganizationBilling(row.organizationId); reconciled++; } catch { /* quarantined */ }
  }
  return { reconciled };
}