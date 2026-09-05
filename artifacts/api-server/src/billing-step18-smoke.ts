import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogsTable, billingEventReceiptsTable, billingOperationsTable, db, organizationBillingTable,
  organizationsTable, plansTable, usersTable, videosTable,
} from "@workspace/db";
import { injectBillingProviderForTest } from "./lib/billing-provider";
import { reconcileActiveBilling, reconcileOrganizationBilling } from "./lib/billing-reconciliation";
import { resolveBillingAccess, resolveEntitlements } from "./lib/entitlements";
import { FakeBillingProvider } from "./lib/test-only-fake-billing-provider";
import { checkoutSubscriptionConflict, withBillingLifecycleLock } from "./lib/billing-lifecycle-lock";
import {
  processVerifiedStripeEvent,
  reconcilePendingBillingReceipts,
} from "./lib/stripe-webhook";
import { trustedStripeUrl, validateExistingCustomerUnderLock } from "./routes/billing";

assert.equal(process.env.NODE_ENV, "test", "billing smoke must run with NODE_ENV=test");
const suffix = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const userId = randomUUID();
const stripeEventIds: string[] = [];
const fake = new FakeBillingProvider();
injectBillingProviderForTest(fake);
try {
  process.env.NODE_ENV = "production";
  assert.throws(
    () => injectBillingProviderForTest(new FakeBillingProvider()),
    /test-only/,
    "test adapters cannot be injected into a production process",
  );
} finally {
  process.env.NODE_ENV = "test";
}
const plans = new Map((await db.select().from(plansTable).where(
  inArray(plansTable.code, ["starter", "growth", "scale"]),
)).map((item) => [item.code, item]));

function subscription(status: string, priceId: string, cancel = false) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `sub_fake_${suffix}`, status, customer: `cus_fake_${suffix}`,
    metadata: { organization_id: organizationId }, cancel_at_period_end: cancel, created: now,
    billing_cycle_anchor: now,
    items: { data: [{ id: `si_fake_${suffix}`, price: { id: priceId }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
  } as unknown as import("stripe").default.Subscription;
}

try {
  const starter = plans.get("starter"); const growth = plans.get("growth"); const scale = plans.get("scale");
  assert(starter && growth && scale, "canonical plans must exist");
  assert(
    (await db.select().from(plansTable)).some(
      (plan) => plan.active && !["starter", "growth", "scale"].includes(plan.code),
    ),
    "billing must coexist with unrelated active plans",
  );
  // Contract values are DB entitlements; fake price IDs allow reconciliation without Stripe.
  assert.equal(starter.storageLimitGb, 100); assert.equal(growth.storageLimitGb, 500); assert.equal(scale.storageLimitGb, 2000);
  assert.equal(starter.entitlements["limits.max_users"], 5);
  assert.equal(growth.entitlements["limits.max_videos"], 500);
  assert.equal(scale.entitlements["limits.monthly_bandwidth_gb"], 10_000);
  for (const [plan, monthly, annual] of [[starter, "price_test_starter_month", "price_test_starter_year"], [growth, "price_test_growth_month", "price_test_growth_year"], [scale, "price_test_scale_month", "price_test_scale_year"]] as const) {
    await db.update(plansTable).set({ stripeProductId: `prod_test_${plan.code}`, stripeMonthlyPriceId: monthly, stripeAnnualPriceId: annual })
      .where(eq(plansTable.id, plan.id));
  }
  await db.insert(usersTable).values({ id: userId, email: `billing-${suffix}@example.test`, name: "Billing smoke" });
  await db.insert(organizationsTable).values({ id: organizationId, name: "Billing smoke", slug: `billing-${suffix}`, status: "active", planId: starter.id });
  await db.insert(organizationBillingTable).values({
    organizationId, stripeCustomerId: `cus_fake_${suffix}`, stripeSubscriptionId: `sub_fake_${suffix}`,
    status: "incomplete",
  });

  // Exact price mapping + active grant.
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_growth_month"));
  let row = await reconcileOrganizationBilling(organizationId, userId);
  assert.equal(row?.status, "active"); assert.equal(row?.currentPlanId, growth.id);
  assert.equal((await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)))[0]!.planId, growth.id);

  // Past due receives grace; recovery grants again; unpaid/canceled fail closed without deleting data.
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("past_due", "price_test_growth_month"));
  row = await reconcileOrganizationBilling(organizationId, userId);
  assert.equal(row?.status, "past_due"); assert(row?.graceEndsAt && row.graceEndsAt > new Date());
  const access = await db.transaction((tx) => resolveBillingAccess(tx, organizationId));
  assert.equal(access.canCreate, true);
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_growth_month"));
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.status, "active");
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("unpaid", "price_test_growth_month"));
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.status, "restricted");
  assert.equal((await db.transaction((tx) => resolveBillingAccess(tx, organizationId))).canCreate, false);
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("canceled", "price_test_growth_month"));
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.status, "restricted");
  assert.equal((await db.select({ count: videosTable.id }).from(videosTable).where(eq(videosTable.organizationId, organizationId))).length, 0, "restriction never deletes data");
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_growth_month"));
  assert.equal((await reconcileActiveBilling(100, organizationId)).reconciled, 1);
  assert.equal(
    (await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId)))[0]!.status,
    "active",
    "periodic reconciliation repairs restricted tenants after payment recovery",
  );

  // Transient provider failures preserve the last authoritative access state
  // and remain retryable; integrity violations persist quarantine before throw.
  fake.failNextRetrieve = true;
  await assert.rejects(() => reconcileOrganizationBilling(organizationId, userId), /fake_transient_provider_failure/);
  let [afterTransient] = await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(afterTransient!.status, "active");
  assert.equal(afterTransient!.lastErrorCode, "billing_reconciliation_retryable");
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.lastErrorCode, null);
  fake.failNextRetrieve = true;
  await assert.rejects(
    () => reconcileActiveBilling(100, organizationId),
    /billing_reconciliation_retryable/,
    "periodic transient failures must reach queue retry/dead-letter handling",
  );
  assert.equal((await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId)))[0]!.status, "active");
  await reconcileOrganizationBilling(organizationId, userId);
  const authoritative = fake.subscriptions.get(`sub_fake_${suffix}`)!;
  fake.subscriptions.set(`sub_fake_${suffix}`, {
    ...authoritative,
    metadata: { organization_id: foreignOrganizationId },
  });
  await assert.rejects(() => reconcileOrganizationBilling(organizationId, userId), /stripe_customer_organization_mismatch/);
  let [afterIntegrityFailure] = await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(afterIntegrityFailure!.status, "quarantined");
  assert.equal(afterIntegrityFailure!.lastErrorCode, "stripe_customer_organization_mismatch");
  fake.subscriptions.set(`sub_fake_${suffix}`, authoritative);
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.status, "active");

  // Verified application receipts bind only through application-controlled
  // customer/subscription/session references and always reconcile authority.
  const eventBase = Math.floor(Date.now() / 1000);
  const verifiedEvent = {
    id: `evt_${suffix.replaceAll("-", "")}_new`,
    type: "customer.subscription.updated",
    created: eventBase,
    data: { object: {
      id: `sub_fake_${suffix}`,
      customer: `cus_fake_${suffix}`,
      metadata: { organization_id: foreignOrganizationId },
    } },
  };
  stripeEventIds.push(verifiedEvent.id);
  fake.retrieveDelayMs = 25;
  await Promise.all([
    processVerifiedStripeEvent(verifiedEvent),
    processVerifiedStripeEvent(verifiedEvent),
  ]);
  fake.retrieveDelayMs = 0;
  assert.equal((await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, verifiedEvent.id))).length, 1);
  const [processedReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, verifiedEvent.id));
  assert.equal(processedReceipt?.processingState, "processed");
  assert.equal(processedReceipt?.organizationId, organizationId);
  assert.equal(processedReceipt?.attempts, 1, "a concurrent duplicate cannot steal a fresh receipt lease");

  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_scale_year"));
  const olderEvent = {
    ...verifiedEvent,
    id: `evt_${suffix.replaceAll("-", "")}_old`,
    created: eventBase - 1,
  };
  stripeEventIds.push(olderEvent.id);
  await processVerifiedStripeEvent(olderEvent);
  const [afterOlderEvent] = await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(afterOlderEvent!.currentPlanId, scale.id, "older delivery reconciles current authority");
  assert.equal(afterOlderEvent!.lastStripeEventId, verifiedEvent.id, "older delivery does not replace the event watermark");

  const retryEvent = {
    ...verifiedEvent,
    id: `evt_${suffix.replaceAll("-", "")}_retry`,
    created: eventBase + 1,
  };
  stripeEventIds.push(retryEvent.id);
  fake.failNextRetrieve = true;
  await assert.rejects(() => processVerifiedStripeEvent(retryEvent), /fake_transient_provider_failure/);
  let [retryReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, retryEvent.id));
  assert.equal(retryReceipt?.processingState, "failed");
  assert.equal((await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId)))[0]!.status, "active");
  await processVerifiedStripeEvent(retryEvent);
  [retryReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, retryEvent.id));
  assert.equal(retryReceipt?.processingState, "processed");

  const unboundSubscriptionId = `sub_unbound_${suffix}`;
  const unboundEvent = {
    ...verifiedEvent,
    id: `evt_${suffix.replaceAll("-", "")}_unbound`,
    type: "invoice.payment_succeeded",
    created: eventBase + 2,
    data: { object: {
      id: `in_unbound_${suffix}`,
      customer: `cus_foreign_${suffix}`,
      subscription: unboundSubscriptionId,
    } },
  };
  stripeEventIds.push(unboundEvent.id);
  await assert.rejects(
    () => processVerifiedStripeEvent(unboundEvent),
    /stripe_event_binding_pending/,
  );
  const [pendingReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, unboundEvent.id));
  assert.equal(pendingReceipt?.processingState, "binding_pending");

  await db.insert(organizationsTable).values({
    id: foreignOrganizationId,
    name: "Foreign billing smoke",
    slug: `foreign-billing-${suffix}`,
    status: "active",
    planId: starter.id,
  });
  await db.insert(organizationBillingTable).values({
    organizationId: foreignOrganizationId,
    stripeCustomerId: `cus_foreign_${suffix}`,
    stripeSubscriptionId: unboundSubscriptionId,
  });
  const foreignSubscription = {
    ...subscription("active", "price_test_starter_month"),
    id: unboundSubscriptionId,
    customer: `cus_foreign_${suffix}`,
    metadata: { organization_id: foreignOrganizationId },
  };
  fake.subscriptions.set(unboundSubscriptionId, foreignSubscription);
  assert.equal((await reconcilePendingBillingReceipts()).reconciled, 1);
  const [recoveredReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, unboundEvent.id));
  assert.equal(recoveredReceipt?.processingState, "processed");
  assert.equal(recoveredReceipt?.organizationId, foreignOrganizationId);

  const removedBindingEventId = `evt_${suffix.replaceAll("-", "")}_removed_binding`;
  stripeEventIds.push(removedBindingEventId);
  await db.insert(billingEventReceiptsTable).values({
    stripeEventId: removedBindingEventId,
    eventType: "invoice.payment_succeeded",
    stripeObjectId: `in_removed_${suffix}`,
    stripeCustomerId: `cus_removed_${suffix}`,
    stripeSubscriptionId: `sub_removed_${suffix}`,
    stripeObjectVersion: String(eventBase + 3),
    organizationId,
    processingState: "failed",
    diagnosticCode: "billing_reconciliation_retryable",
  });
  assert.equal((await reconcilePendingBillingReceipts()).reconciled, 0);
  const [removedBindingReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, removedBindingEventId));
  assert.equal(removedBindingReceipt?.processingState, "quarantined");
  assert.equal(removedBindingReceipt?.diagnosticCode, "stripe_event_binding_changed");

  const sweepAmbiguousEventId = `evt_${suffix.replaceAll("-", "")}_sweep_ambiguous`;
  stripeEventIds.push(sweepAmbiguousEventId);
  await db.insert(billingEventReceiptsTable).values({
    stripeEventId: sweepAmbiguousEventId,
    eventType: "invoice.payment_succeeded",
    stripeObjectId: `in_ambiguous_${suffix}`,
    stripeCustomerId: `cus_foreign_${suffix}`,
    stripeSubscriptionId: `sub_fake_${suffix}`,
    stripeObjectVersion: String(eventBase + 3),
    processingState: "binding_pending",
    diagnosticCode: "stripe_event_binding_pending",
  });
  assert.equal((await reconcilePendingBillingReceipts()).reconciled, 0);
  const [sweepAmbiguousReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, sweepAmbiguousEventId));
  assert.equal(sweepAmbiguousReceipt?.processingState, "quarantined");
  assert.equal(sweepAmbiguousReceipt?.diagnosticCode, "stripe_event_binding_ambiguous");

  const ambiguousBindingEvent = {
    ...verifiedEvent,
    id: `evt_${suffix.replaceAll("-", "")}_ambiguous`,
    created: eventBase + 4,
    data: { object: {
      id: `sub_fake_${suffix}`,
      customer: `cus_foreign_${suffix}`,
    } },
  };
  stripeEventIds.push(ambiguousBindingEvent.id);
  await processVerifiedStripeEvent(ambiguousBindingEvent);
  const [ambiguousReceipt] = await db.select().from(billingEventReceiptsTable)
    .where(eq(billingEventReceiptsTable.stripeEventId, ambiguousBindingEvent.id));
  assert.equal(ambiguousReceipt?.organizationId, null);
  assert.equal(ambiguousReceipt?.processingState, "quarantined");
  assert.equal(ambiguousReceipt?.diagnosticCode, "stripe_event_binding_ambiguous");

  assert.equal(trustedStripeUrl("https://invoice.stripe.com/i/test"), "https://invoice.stripe.com/i/test");
  assert.equal(trustedStripeUrl("https://stripe.com.evil.test/invoice"), null);
  assert.equal(trustedStripeUrl("http://invoice.stripe.com/invoice"), null);

  // Repeated and logically older delivery hints never win: reconciliation always retrieves the current fake object.
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_scale_year"));
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.currentPlanId, scale.id);
  assert.equal((await reconcileOrganizationBilling(organizationId, userId))?.currentPlanId, scale.id, "duplicate reconciliation is monotonic");
  // The first delayed retrieve and a later caller are serialized by the
  // organization advisory lock; final state reflects the later authority.
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("past_due", "price_test_growth_month"));
  fake.retrieveDelayMs = 25;
  const stale = reconcileOrganizationBilling(organizationId, userId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fake.subscriptions.set(`sub_fake_${suffix}`, subscription("active", "price_test_scale_year"));
  const fresh = reconcileOrganizationBilling(organizationId, userId);
  await Promise.all([stale, fresh]);
  fake.retrieveDelayMs = 0;
  assert.equal((await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId)))[0]!.currentPlanId, scale.id);

  // Exact handoff: a caller's stale pre-lock no-subscription observation cannot
  // authorize create after reconciliation acquires the shared lifecycle lock.
  await db.update(organizationBillingTable).set({ stripeSubscriptionId: null, status: "unmanaged" })
    .where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal((await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId)))[0]!.stripeSubscriptionId, null);
  fake.retrieveDelayMs = 25;
  const beforeCheckoutCalls = fake.calls.filter((item) => item.operation === "checkout").length;
  const winningReconcile = reconcileOrganizationBilling(organizationId, userId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const losingCheckout = withBillingLifecycleLock(organizationId, async () => {
    const [locked] = await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId));
    if (locked!.stripeSubscriptionId || ["active", "trialing", "past_due"].includes(locked!.status)) return "subscription_exists";
    await fake.createCheckout({ customerId: `cus_fake_${suffix}`, organizationId, idempotencyKey: "must-not-run" });
    return "created";
  });
  assert.equal((await Promise.all([winningReconcile, losingCheckout]))[1], "subscription_exists");
  assert.equal(fake.calls.filter((item) => item.operation === "checkout").length, beforeCheckoutCalls);
  fake.retrieveDelayMs = 0;

  // Reverse ordering: reconciliation waits for Checkout's lifecycle section,
  // then authoritatively discovers the subscription and clears pending state.
  await db.update(organizationBillingTable).set({ stripeSubscriptionId: null, status: "unmanaged" })
    .where(eq(organizationBillingTable.organizationId, organizationId));
  let reverseReconciled = false;
  let reverse: Promise<unknown> | undefined;
  await withBillingLifecycleLock(organizationId, async () => {
    const reverseCheckout = await fake.createCheckout({
      customerId: `cus_fake_${suffix}`, organizationId, idempotencyKey: `reverse:${suffix}`,
    });
    await db.update(organizationBillingTable).set({
      pendingCheckoutSessionId: reverseCheckout.id, pendingCheckoutPlanId: growth.id,
      pendingCheckoutPriceId: "price_test_growth_month", pendingCheckoutInterval: "month",
      pendingCheckoutExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(organizationBillingTable.organizationId, organizationId));
    reverse = reconcileOrganizationBilling(organizationId, userId).finally(() => { reverseReconciled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reverseReconciled, false);
  });
  await reverse;
  const [afterReverse] = await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(afterReverse!.status, "active");
  assert.equal(afterReverse!.pendingCheckoutSessionId, null);

  // Terminal canceled authority permits exactly one lifecycle-locked
  // resubscribe, reuses the customer, and is superseded by new authority.
  const oldSubscriptionId = afterReverse!.stripeSubscriptionId!;
  fake.subscriptions.set(oldSubscriptionId, subscription("canceled", "price_test_scale_year"));
  const canceled = await reconcileOrganizationBilling(organizationId, userId);
  assert.equal(canceled!.status, "restricted");
  assert.equal(canceled!.stripeSubscriptionStatus, "canceled");
  assert.equal(checkoutSubscriptionConflict(oldSubscriptionId, "active", "active"), "subscription_active");
  assert.equal(checkoutSubscriptionConflict(oldSubscriptionId, "past_due", "past_due"), "subscription_past_due");
  assert.equal(checkoutSubscriptionConflict(oldSubscriptionId, "unpaid", "restricted"), "subscription_unpaid");
  assert.equal(checkoutSubscriptionConflict(oldSubscriptionId, "canceled", "restricted"), null);
  const checkoutCallsBeforeResubscribe = fake.calls.filter((item) => item.operation === "checkout").length;
  const customerCallsBeforeResubscribe = fake.calls.filter((item) => item.operation === "customer").length;
  const resubscribe = () => withBillingLifecycleLock(organizationId, async () => {
    let [locked] = await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId));
    if (locked!.stripeSubscriptionId) {
      assert.equal(locked!.stripeSubscriptionStatus, "canceled");
      [locked] = await db.update(organizationBillingTable).set({
        stripeSubscriptionId: null, stripeSubscriptionStatus: null,
      }).where(eq(organizationBillingTable.organizationId, organizationId)).returning();
    }
    if (locked!.pendingCheckoutSessionId) return locked!.pendingCheckoutSessionId;
    const session = await fake.createCheckout({
      customerId: locked!.stripeCustomerId!, organizationId, idempotencyKey: `resubscribe:${suffix}`,
    });
    await db.update(organizationBillingTable).set({
      pendingCheckoutSessionId: session.id, pendingCheckoutPlanId: scale.id,
      pendingCheckoutPriceId: "price_test_scale_year", pendingCheckoutInterval: "year",
      pendingCheckoutExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(organizationBillingTable.organizationId, organizationId));
    return session.id;
  });
  const resubscribeResults = await Promise.all([resubscribe(), resubscribe()]);
  assert.equal(resubscribeResults[0], resubscribeResults[1]);
  assert.equal(fake.calls.filter((item) => item.operation === "checkout").length, checkoutCallsBeforeResubscribe + 1);
  assert.equal(fake.calls.filter((item) => item.operation === "customer").length, customerCallsBeforeResubscribe);
  const newSubscription = { ...subscription("active", "price_test_scale_year"), id: `sub_fake_resubscribe_${suffix}` };
  fake.subscriptions.set(newSubscription.id, newSubscription);
  const resubscribed = await reconcileOrganizationBilling(organizationId, userId);
  assert.equal(resubscribed!.stripeSubscriptionId, newSubscription.id);
  assert.equal(resubscribed!.stripeSubscriptionStatus, "active");
  assert.equal(resubscribed!.pendingCheckoutSessionId, null);

  // Fake adapter supports Stripe period-end cancellation, resume, and schedule semantics.
  const active = subscription("active", "price_test_growth_month");
  fake.subscriptions.set(active.id, active);
  assert.equal((await fake.setCancelAtPeriodEnd({ subscriptionId: active.id, cancel: true })).cancel_at_period_end, true);
  assert.equal((await fake.setCancelAtPeriodEnd({ subscriptionId: active.id, cancel: false })).cancel_at_period_end, false);
  assert.match((await fake.scheduleDowngrade({
    subscription: active,
    priceId: "price_test_starter_month",
  })).id, /^sub_sched_/);
  await db.update(organizationBillingTable).set({
    pendingPlanId: starter.id,
    pendingEffectiveAt: new Date(Date.now() + 86400_000),
    pendingSubscriptionScheduleId: `sub_sched_missing_${suffix}`,
  }).where(eq(organizationBillingTable.organizationId, organizationId));
  fake.subscriptions.set(active.id, active);
  await reconcileOrganizationBilling(organizationId, userId);
  const [afterMissingSchedule] = await db.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(afterMissingSchedule!.pendingPlanId, null);
  assert.equal(afterMissingSchedule!.pendingSubscriptionScheduleId, null);
  assert.equal(afterMissingSchedule!.lastErrorCode, "stripe_downgrade_schedule_missing");

  // Durable claim uniqueness gives checkout replay reuse and rejects conflicting request fingerprints.
  const key = randomUUID();
  await db.insert(billingOperationsTable).values({ organizationId, actorUserId: userId, operation: "checkout", idempotencyKey: key, requestFingerprint: "a" });
  await assert.rejects(() => db.insert(billingOperationsTable).values({ organizationId, actorUserId: userId, operation: "checkout", idempotencyKey: key, requestFingerprint: "b" }));
  assert.equal((await fake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}` })).id,
    (await fake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}` })).id);
  assert.equal(fake.calls.filter((item) => item.operation === "customer").length, 1);

  const audit = await db.select().from(auditLogsTable).where(eq(auditLogsTable.organizationId, organizationId));
  const statusChanges = audit.filter((item) => item.action === "billing.status_changed");
  assert(statusChanges.some((item) =>
    (item.beforeState as { status?: string } | null)?.status === "active"
    && (item.afterState as { status?: string } | null)?.status === "past_due"),
  "past-due transition uses billing.status_changed");
  assert(statusChanges.some((item) =>
    (item.beforeState as { status?: string } | null)?.status === "past_due"
    && (item.afterState as { status?: string } | null)?.status === "active"),
  "payment recovery uses billing.status_changed");
  assert(statusChanges.every((item) => item.actorKind === "user" && item.actorUserId === userId));
  for (const item of statusChanges) {
    const serialized = JSON.stringify({
      subjectId: item.subjectId,
      beforeState: item.beforeState,
      afterState: item.afterState,
      metadata: item.metadata,
    });
    assert.equal(/cus_fake_|sub_fake_|stripe/i.test(serialized), false, "audit excludes Stripe IDs");
    assert.equal(/https?:\/\//i.test(serialized), false, "audit excludes provider URLs");
    assert.deepEqual(item.metadata, {}, "status transition metadata is sanitized and minimal");
  }
  const entitlements = await db.transaction((tx) => resolveEntitlements(tx, organizationId));
  assert.equal(entitlements["limits.max_videos"], 2500);

  // Customer repair primitives: generations bypass deleted historical
  // idempotency results, and ambiguous creates are discoverable by metadata.
  const customerFake = new FakeBillingProvider();
  const oldCustomer = await customerFake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}:generation:0` });
  customerFake.customers.get(`customer:${organizationId}:generation:0`)!.deleted = true;
  const replacement = await customerFake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}:generation:1` });
  assert.notEqual(replacement.id, oldCustomer.id);
  assert.equal((await customerFake.retrieveCustomer(oldCustomer.id)), null);
  const ambiguousOrganization = randomUUID();
  customerFake.ambiguousNextCustomer = true;
  await assert.rejects(() => customerFake.createCustomer({
    organizationId: ambiguousOrganization, idempotencyKey: `customer:${ambiguousOrganization}:generation:0`,
  }));
  const recovered = await customerFake.findCustomersByOrganization(ambiguousOrganization);
  assert.equal(recovered.length, 1, "ambiguous create is recovered without duplication");
  assert.equal((await customerFake.createCustomer({
    organizationId: ambiguousOrganization, idempotencyKey: `customer:${ambiguousOrganization}:generation:0`,
  })).id, recovered[0]!.id);
  await customerFake.createCustomer({ organizationId: ambiguousOrganization, idempotencyKey: `customer:${ambiguousOrganization}:generation:1` });
  assert.equal((await customerFake.findCustomersByOrganization(ambiguousOrganization)).length, 2, "multiple metadata matches are detectable");
  assert.equal((await customerFake.findCustomersByOrganization(randomUUID())).length, 0, "cross-tenant customers are never adopted");

  // A missing customer on a live subscription quarantines without replacing
  // or clearing subscription/customer identity.
  await db.update(organizationBillingTable).set({
    stripeCustomerId: `cus_missing_live_${suffix}`, stripeSubscriptionId: newSubscription.id,
    stripeSubscriptionStatus: "active", status: "active",
  }).where(eq(organizationBillingTable.organizationId, organizationId));
  const request = { id: "billing-smoke", tenant: { organizationId, userId } } as Parameters<typeof validateExistingCustomerUnderLock>[0];
  await assert.rejects(() => withBillingLifecycleLock(organizationId, () => validateExistingCustomerUnderLock(request)));
  const [quarantined] = await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(quarantined!.status, "quarantined");
  assert.equal(quarantined!.stripeCustomerId, `cus_missing_live_${suffix}`);
  assert.equal(quarantined!.stripeSubscriptionId, newSubscription.id);
  const [quarantineAudit] = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organizationId),
    eq(auditLogsTable.action, "billing.customer_reference_quarantined"),
  ));
  assert.equal(quarantineAudit?.actorUserId, userId);
  assert.equal((quarantineAudit?.metadata as { code?: string } | null)?.code, "stripe_customer_missing_for_subscription");
  assert.equal(JSON.stringify(quarantineAudit).includes(`cus_missing_live_${suffix}`), false);
  const generationBeforeRepair = quarantined!.stripeCustomerGeneration;
  await db.update(organizationBillingTable).set({
    stripeCustomerId: `cus_missing_orphan_${suffix}`,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: "canceled",
  }).where(eq(organizationBillingTable.organizationId, organizationId));
  const repaired = await withBillingLifecycleLock(
    organizationId,
    () => validateExistingCustomerUnderLock(request),
  );
  assert.equal(repaired!.stripeCustomerId, null);
  assert.equal(repaired!.stripeCustomerGeneration, generationBeforeRepair + 1);
  const [repairAudit] = await db.select().from(auditLogsTable).where(and(
    eq(auditLogsTable.organizationId, organizationId),
    eq(auditLogsTable.action, "billing.customer_reference_repaired"),
  ));
  assert.equal(repairAudit?.actorUserId, userId);
  assert.equal((repairAudit?.beforeState as { customerGeneration?: number } | null)?.customerGeneration, generationBeforeRepair);
  assert.equal((repairAudit?.afterState as { customerGeneration?: number } | null)?.customerGeneration, generationBeforeRepair + 1);
  assert.equal(JSON.stringify(repairAudit).includes(`cus_missing_orphan_${suffix}`), false);
  console.log(JSON.stringify({ billingSmoke: "ok", reconciliations: 4, fakeExternalCalls: fake.calls.length }));
} finally {
  injectBillingProviderForTest(new FakeBillingProvider());
  if (stripeEventIds.length) {
    await db.delete(billingEventReceiptsTable)
      .where(inArray(billingEventReceiptsTable.stripeEventId, stripeEventIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  for (const plan of plans.values()) if (["starter", "growth", "scale"].includes(plan.code)) {
    await db.update(plansTable).set({
      stripeProductId: plan.stripeProductId, stripeMonthlyPriceId: plan.stripeMonthlyPriceId, stripeAnnualPriceId: plan.stripeAnnualPriceId,
    }).where(eq(plansTable.id, plan.id));
  }
}