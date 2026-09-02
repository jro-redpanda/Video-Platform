import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogsTable, billingOperationsTable, db, organizationBillingTable,
  organizationsTable, plansTable, usersTable, videosTable,
} from "@workspace/db";
import { injectBillingProviderForTest } from "./lib/billing-provider";
import { reconcileOrganizationBilling } from "./lib/billing-reconciliation";
import { resolveBillingAccess, resolveEntitlements } from "./lib/entitlements";
import { FakeBillingProvider } from "./lib/test-only-fake-billing-provider";
import { checkoutSubscriptionConflict, withBillingLifecycleLock } from "./lib/billing-lifecycle-lock";
import { validateExistingCustomerUnderLock } from "./routes/billing";

assert.equal(process.env.NODE_ENV, "test", "billing smoke must run with NODE_ENV=test");
const suffix = randomUUID();
const organizationId = randomUUID();
const userId = randomUUID();
const fake = new FakeBillingProvider();
injectBillingProviderForTest(fake);
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
  assert.match((await fake.scheduleDowngrade({ subscription: active })).id, /^sub_sched_/);

  // Durable claim uniqueness gives checkout replay reuse and rejects conflicting request fingerprints.
  const key = randomUUID();
  await db.insert(billingOperationsTable).values({ organizationId, actorUserId: userId, operation: "checkout", idempotencyKey: key, requestFingerprint: "a" });
  await assert.rejects(() => db.insert(billingOperationsTable).values({ organizationId, actorUserId: userId, operation: "checkout", idempotencyKey: key, requestFingerprint: "b" }));
  assert.equal((await fake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}` })).id,
    (await fake.createCustomer({ organizationId, idempotencyKey: `customer:${organizationId}` })).id);
  assert.equal(fake.calls.filter((item) => item.operation === "customer").length, 1);

  const audit = await db.select().from(auditLogsTable).where(eq(auditLogsTable.organizationId, organizationId));
  assert(audit.some((item) => item.action === "billing payment failed"));
  assert(audit.some((item) => item.action === "billing payment recovered"));
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
  const request = { tenant: { organizationId, userId } } as Parameters<typeof validateExistingCustomerUnderLock>[0];
  await assert.rejects(() => withBillingLifecycleLock(organizationId, () => validateExistingCustomerUnderLock(request)));
  const [quarantined] = await db.select().from(organizationBillingTable).where(eq(organizationBillingTable.organizationId, organizationId));
  assert.equal(quarantined!.status, "quarantined");
  assert.equal(quarantined!.stripeCustomerId, `cus_missing_live_${suffix}`);
  assert.equal(quarantined!.stripeSubscriptionId, newSubscription.id);
  console.log(JSON.stringify({ billingSmoke: "ok", reconciliations: 4, fakeExternalCalls: fake.calls.length }));
} finally {
  injectBillingProviderForTest(new FakeBillingProvider());
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  for (const plan of plans.values()) if (["starter", "growth", "scale"].includes(plan.code)) {
    await db.update(plansTable).set({
      stripeProductId: plan.stripeProductId, stripeMonthlyPriceId: plan.stripeMonthlyPriceId, stripeAnnualPriceId: plan.stripeAnnualPriceId,
    }).where(eq(plansTable.id, plan.id));
  }
}