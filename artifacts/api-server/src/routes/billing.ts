import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  billingOperationsTable, db, groupPermissionsTable, membershipsTable,
  organizationBillingTable, organizationsTable, plansTable,
} from "@workspace/db";
import { billingProvider, type BillingInterval } from "../lib/billing-provider";
import {
  reconcileOrganizationBilling,
  reconcileOrganizationBillingUnderLock,
} from "../lib/billing-reconciliation";
import { requirePermission } from "../lib/permissions";
import { withTenantDb } from "../lib/tenant-db";
import { trustedRequestOrigin } from "../lib/video-embeds";
import { getUncachableStripeClient } from "../lib/stripe-client";
import { checkoutSubscriptionConflict, withBillingLifecycleLock } from "../lib/billing-lifecycle-lock";
import { auditUser, writeAuditEvent } from "../lib/audit";
import {
  CancelBillingSubscriptionBody,
  CancelBillingSubscriptionResponse,
  ChangeBillingPlanBody,
  ChangeBillingPlanResponse,
  CreateBillingCheckoutBody,
  CreateBillingCheckoutResponse,
  CreateBillingPortalBody,
  CreateBillingPortalResponse,
  GetBillingCatalogResponse,
  GetBillingSubscriptionResponse,
  ListBillingInvoicesQueryParams,
  ListBillingInvoicesResponse,
  ReconcileBillingSubscriptionBody,
  ReconcileBillingSubscriptionResponse,
  ResumeBillingSubscriptionBody,
  ResumeBillingSubscriptionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function idempotency(request: unknown) {
  const bodyValue = (request as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  const value = typeof bodyValue === "string" ? bodyValue : undefined;
  if (!value || !uuid.test(value)) throw new BillingInputError("invalid_idempotency_key");
  return value.toLowerCase();
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}
class BillingInputError extends Error {}
class CheckoutConflictError extends Error {}
class SubscriptionExistsError extends Error {
  constructor(readonly code: string) { super(code); }
}
class CustomerReferenceError extends Error {
  constructor(readonly code: string) { super(code); }
}
type PublicBillingError = { status: number; error: string; code: string };
function publicBillingError(error: unknown, operation: string): PublicBillingError {
  if (error instanceof BillingInputError) {
    return { status: 422, error: "The billing request is invalid", code: "invalid_billing_request" };
  }
  if (error instanceof CheckoutConflictError) {
    return { status: 409, error: "Another checkout is already in progress", code: "checkout_in_progress" };
  }
  if (error instanceof SubscriptionExistsError) {
    return { status: 409, error: "The workspace already has a subscription", code: error.code };
  }
  if (error instanceof CustomerReferenceError) {
    return { status: 409, error: "The billing account requires reconciliation", code: error.code };
  }
  return {
    status: 502,
    error: `The billing ${operation.replaceAll("_", " ")} is temporarily unavailable`,
    code: `billing_${operation.replaceAll("-", "_")}_failed`,
  };
}

export function trustedStripeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const stripeOwned = hostname === "stripe.com" || hostname.endsWith(".stripe.com");
    const testOwned = process.env.NODE_ENV === "test"
      && (hostname === "stripe.test" || hostname.endsWith(".stripe.test"));
    return url.protocol === "https:" && !url.username && !url.password && (stripeOwned || testOwned)
      ? url.toString() : null;
  } catch {
    return null;
  }
}
function hasExactKeys(value: unknown, keys: string[]) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key));
}

async function claim(req: Request, operation: string, request: unknown) {
  const expected = operation === "checkout" || operation === "change_plan"
    ? ["plan", "interval", "idempotencyKey"] : ["idempotencyKey"];
  if (!hasExactKeys(request, expected)) throw new BillingInputError("invalid_billing_request");
  const key = idempotency(request);
  const requestFingerprint = fingerprint(request);
  return withTenantDb(req.tenant, async (tx) => {
    const [created] = await tx.insert(billingOperationsTable).values({
      organizationId: req.tenant.organizationId, actorUserId: req.tenant.userId,
      operation, idempotencyKey: key, requestFingerprint,
    }).onConflictDoNothing().returning();
    if (created) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: `billing.${operation}.requested`, category: "billing",
      subject: { type: "billing_operation", id: created.id, label: operation },
      requestId: String(req.id),
    });
    const row = created ?? (await tx.select().from(billingOperationsTable).where(and(
      eq(billingOperationsTable.organizationId, req.tenant.organizationId),
      eq(billingOperationsTable.operation, operation),
      eq(billingOperationsTable.idempotencyKey, key),
    )).limit(1))[0];
    if (!row || row.requestFingerprint !== requestFingerprint) throw new BillingInputError("Idempotency key reused with different input");
    return row;
  });
}

function parseBody<T>(
  req: Request,
  exactKeys: string[],
  parser: (value: unknown) => T,
) {
  if (!hasExactKeys(req.body, exactKeys)) throw new BillingInputError("invalid_billing_request");
  try {
    return parser(req.body);
  } catch {
    throw new BillingInputError("invalid_billing_request");
  }
}

function parseInvoiceQuery(req: Request) {
  if (!hasExactKeys(req.query, ["limit", "cursor"])) throw new BillingInputError("invalid_invoice_query");
  try {
    return ListBillingInvoicesQueryParams.parse(req.query);
  } catch {
    throw new BillingInputError("invalid_invoice_query");
  }
}

async function complete(req: Request, id: string, action: string, subjectId: string | null, result: Record<string, string | number | boolean | null>) {
  await withTenantDb(req.tenant, async (tx) => {
    const [changed] = await tx.update(billingOperationsTable).set({
      state: "completed", result, stripeObjectId: subjectId, completedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(billingOperationsTable.id, id),
      eq(billingOperationsTable.organizationId, req.tenant.organizationId),
      inArray(billingOperationsTable.state, ["claimed", "failed"]),
    )).returning({ id: billingOperationsTable.id });
    if (changed) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: action.replace(/\s+/g, ".").replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase(), category: "billing",
      subject: { type: "billing_operation", id, label: "completed" },
      afterState: { state: "completed" }, requestId: String(req.id),
    });
  });
}

async function completeCheckout(
  req: Request,
  operation: typeof billingOperationsTable.$inferSelect,
  sessionId: string,
  result: { url: string },
) {
  await withTenantDb(req.tenant, async (tx) => {
    const [billing] = await tx.update(organizationBillingTable).set({
      pendingCheckoutSessionId: sessionId,
      pendingCheckoutExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      updatedAt: new Date(),
    }).where(and(
      eq(organizationBillingTable.organizationId, req.tenant.organizationId),
      eq(organizationBillingTable.pendingCheckoutOperationId, operation.id),
    )).returning({ organizationId: organizationBillingTable.organizationId });
    if (!billing) throw new Error("billing_checkout_claim_changed");

    const [changed] = await tx.update(billingOperationsTable).set({
      state: "completed",
      result,
      stripeObjectId: sessionId,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(billingOperationsTable.id, operation.id),
      eq(billingOperationsTable.organizationId, req.tenant.organizationId),
      inArray(billingOperationsTable.state, ["claimed", "failed"]),
    )).returning({ id: billingOperationsTable.id });
    if (!changed) {
      const [existing] = await tx.select({ state: billingOperationsTable.state })
        .from(billingOperationsTable)
        .where(and(
          eq(billingOperationsTable.id, operation.id),
          eq(billingOperationsTable.organizationId, req.tenant.organizationId),
        ))
        .limit(1);
      if (existing?.state === "completed") return;
      throw new Error("billing_checkout_operation_changed");
    }
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId,
      actor: auditUser(req.tenant.userId),
      action: "billing.checkout.completed",
      category: "billing",
      subject: { type: "billing_operation", id: operation.id, label: "completed" },
      afterState: { state: "completed" },
      requestId: String(req.id),
    });
  });
}

async function fail(req: Request, id: string, action: string, error: unknown) {
  // Provider error text can contain URLs or opaque identifiers.
  const code = "billing_operation_failed";
  await withTenantDb(req.tenant, async (tx) => {
    const [changed] = await tx.update(billingOperationsTable).set({ state: "failed", errorCode: code, updatedAt: new Date() })
      .where(and(
        eq(billingOperationsTable.id, id),
        eq(billingOperationsTable.organizationId, req.tenant.organizationId),
        eq(billingOperationsTable.state, "claimed"),
      )).returning({ id: billingOperationsTable.id });
    if (changed) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: action.replace(/\s+/g, ".").replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase(), category: "billing",
      subject: { type: "billing_operation", id, label: "failed" },
      afterState: { state: "failed" }, metadata: { code }, requestId: String(req.id),
    });
  });
}

async function catalog() {
  const stripe = await getUncachableStripeClient();
  const plans = await db.select().from(plansTable)
    .where(and(
      eq(plansTable.active, true),
      isNotNull(plansTable.monthlyAmountCents),
      isNotNull(plansTable.annualAmountCents),
    )).orderBy(asc(plansTable.sortOrder));
  if (plans.length !== 3) {
    throw new Error("billing_catalog_missing_commercial_plan");
  }
  return Promise.all(plans.map(async (plan) => {
    const entries = await Promise.all((["month", "year"] as const).map(async (interval) => {
      const priceId = interval === "month" ? plan.stripeMonthlyPriceId : plan.stripeAnnualPriceId;
      if (!priceId) throw new Error(`billing_catalog_unsynced_${plan.code}_${interval}`);
      const price = await stripe.prices.retrieve(priceId);
      const expected = interval === "month" ? plan.monthlyAmountCents : plan.annualAmountCents;
      const productId = typeof price.product === "string" ? price.product : price.product.id;
      if (!price.active || price.currency !== "usd" || price.unit_amount !== expected ||
          price.recurring?.interval !== interval || price.metadata.plan_code !== plan.code ||
          price.metadata.billing_interval !== interval || price.metadata.catalog_owner !== "vid" ||
          productId !== plan.stripeProductId) throw new Error(`billing_catalog_mismatch_${plan.code}_${interval}`);
      return { interval, amount: price.unit_amount, currency: price.currency };
    }));
    return { code: plan.code, name: plan.name, description: plan.description, entitlements: plan.entitlements, prices: entries };
  }));
}

router.get("/billing/catalog", async (_req, res) => {
  try { res.json(GetBillingCatalogResponse.parse({ plans: await catalog() })); }
  catch { res.status(503).json({ error: "Billing catalog is unavailable or mismatched", code: "billing_catalog_unavailable" }); }
});

router.get("/billing/subscription", async (req, res) => {
  const value = await withTenantDb(req.tenant, async (tx) => {
    const [row] = await tx.select({
      status: organizationBillingTable.status, interval: organizationBillingTable.interval,
      periodStart: organizationBillingTable.periodStart, periodEnd: organizationBillingTable.periodEnd,
      cancelAtPeriodEnd: organizationBillingTable.cancelAtPeriodEnd,
      graceEndsAt: organizationBillingTable.graceEndsAt,
      pendingPlanId: organizationBillingTable.pendingPlanId,
      pendingEffectiveAt: organizationBillingTable.pendingEffectiveAt,
      stripeSubscriptionId: organizationBillingTable.stripeSubscriptionId,
      stripeSubscriptionStatus: organizationBillingTable.stripeSubscriptionStatus,
      plan: plansTable.code,
    }).from(organizationBillingTable)
      .leftJoin(plansTable, eq(plansTable.id, organizationBillingTable.currentPlanId))
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).limit(1);
    const [manager] = await tx.select({ key: groupPermissionsTable.permissionKey }).from(membershipsTable)
      .innerJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, membershipsTable.groupId))
      .where(and(
        eq(membershipsTable.organizationId, req.tenant.organizationId),
        eq(membershipsTable.userId, req.tenant.userId),
        eq(membershipsTable.status, "active"),
        eq(groupPermissionsTable.permissionKey, "workspace.manage"),
      )).limit(1);
    const pendingPlan = row?.pendingPlanId
      ? (await tx.select({ code: plansTable.code }).from(plansTable).where(eq(plansTable.id, row.pendingPlanId)).limit(1))[0]?.code ?? null
      : null;
    return {
      ...(row ?? {
        status: "unmanaged", interval: null, periodStart: null, periodEnd: null,
        cancelAtPeriodEnd: false, graceEndsAt: null, plan: null,
        pendingPlanId: null, pendingEffectiveAt: null,
        stripeSubscriptionId: null, stripeSubscriptionStatus: null,
      }),
      pendingPlan, canManage: Boolean(manager),
      canSubscribe: !row || (!row.stripeSubscriptionId && row.status === "unmanaged") ||
        (row.status === "restricted" && row.stripeSubscriptionStatus === "canceled"),
    };
  });
  const {
    canManage, canSubscribe, pendingPlanId: _, stripeSubscriptionId: _subscriptionId,
    stripeSubscriptionStatus: _providerStatus, ...subscription
  } = value;
  res.json(GetBillingSubscriptionResponse.parse({
    ...subscription,
    capabilities: { canManage, canSubscribe },
  }));
});

router.post("/billing/checkout", requirePermission("workspace.manage"), async (req, res) => {
  let operation: typeof billingOperationsTable.$inferSelect | undefined;
  try {
    const body = parseBody(req, ["plan", "interval", "idempotencyKey"], (value) =>
      CreateBillingCheckoutBody.parse(value));
    operation = await claim(req, "checkout", body);
    if (!operation) throw new Error("billing_operation_claim_missing");
    if (operation.state === "completed") {
      const url = trustedStripeUrl(operation.result?.url);
      if (!url) throw new Error("billing_checkout_result_invalid");
      return void res.json(CreateBillingCheckoutResponse.parse({ url }));
    }
    const plan = await planByCode(req, body.plan);
    const priceId = body.interval === "month" ? plan?.stripeMonthlyPriceId : plan?.stripeAnnualPriceId;
    if (!plan || !plan.active || !priceId) throw new BillingInputError("Unknown or unsynced plan");
    const origin = trustedRequestOrigin(req);
    const checkout = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const checkoutOperation = await billingOperation(req, operation!.id);
      if (!checkoutOperation) throw new Error("billing_operation_claim_missing");
      if (checkoutOperation.state === "completed") {
        const url = trustedStripeUrl(checkoutOperation.result?.url);
        if (!url) throw new Error("billing_checkout_result_invalid");
        return {
          result: { url },
          sessionId: checkoutOperation.stripeObjectId,
          reused: true,
        };
      }
      await validateExistingCustomerUnderLock(req);
      const decision = await withTenantDb(req.tenant, async (tx) => {
        let [locked] = await tx.select().from(organizationBillingTable)
          .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).for("update").limit(1);
        if (locked?.stripeSubscriptionId) {
          const authority = await billingProvider().retrieveSubscription(locked.stripeSubscriptionId);
          const customerId = typeof authority.customer === "string" ? authority.customer : authority.customer.id;
          if (customerId !== locked.stripeCustomerId || authority.metadata.organization_id !== req.tenant.organizationId) {
            throw new CustomerReferenceError("billing_subscription_mismatch");
          }
          const providerStatus = authority.status as typeof locked.stripeSubscriptionStatus;
          const conflict = checkoutSubscriptionConflict(locked.stripeSubscriptionId, providerStatus, locked.status);
          if (conflict) throw new SubscriptionExistsError(conflict);
          [locked] = await tx.update(organizationBillingTable).set({
            stripeSubscriptionId: null, stripeSubscriptionStatus: null,
            interval: null, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false,
            graceEndsAt: null, pendingPlanId: null, pendingEffectiveAt: null,
            pendingSubscriptionScheduleId: null, updatedAt: new Date(),
          }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).returning();
        } else if (locked) {
          const conflict = checkoutSubscriptionConflict(null, locked.stripeSubscriptionStatus, locked.status);
          if (conflict) throw new SubscriptionExistsError(conflict);
        }
        const now = new Date();
        const claimDeadline = new Date(now.getTime() + 10 * 60_000);
        if (locked?.pendingCheckoutSessionId && locked.pendingCheckoutExpiresAt && locked.pendingCheckoutExpiresAt > now) {
          const same = locked.pendingCheckoutPlanId === plan.id && locked.pendingCheckoutPriceId === priceId && locked.pendingCheckoutInterval === body.interval;
          const [prior] = locked.pendingCheckoutOperationId
            ? await tx.select().from(billingOperationsTable).where(eq(billingOperationsTable.id, locked.pendingCheckoutOperationId)).limit(1) : [];
          if (same) {
            if (prior?.result?.url) return { reuse: prior.result as { url: string }, sessionId: locked.pendingCheckoutSessionId };
            throw new CheckoutConflictError("checkout_in_progress");
          }
          if (!prior || prior.state !== "completed") throw new CheckoutConflictError("checkout_in_progress");
          await tx.update(organizationBillingTable).set({
            pendingCheckoutPlanId: plan.id, pendingCheckoutPriceId: priceId, pendingCheckoutInterval: body.interval,
            pendingCheckoutOperationId: checkoutOperation.id, updatedAt: now,
          }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId));
          return { customerId: locked.stripeCustomerId, expire: locked.pendingCheckoutSessionId };
        }
        if (locked?.pendingCheckoutOperationId && locked.pendingCheckoutOperationId !== checkoutOperation.id) throw new CheckoutConflictError("checkout_in_progress");
        await tx.insert(organizationBillingTable).values({
          organizationId: req.tenant.organizationId, stripeCustomerId: locked?.stripeCustomerId ?? null,
          pendingCheckoutPlanId: plan.id, pendingCheckoutPriceId: priceId,
          pendingCheckoutInterval: body.interval, pendingCheckoutOperationId: checkoutOperation.id,
          pendingCheckoutExpiresAt: claimDeadline,
        }).onConflictDoUpdate({ target: organizationBillingTable.organizationId, set: {
          pendingCheckoutPlanId: plan.id, pendingCheckoutPriceId: priceId,
          pendingCheckoutInterval: body.interval, pendingCheckoutOperationId: checkoutOperation.id,
          pendingCheckoutExpiresAt: claimDeadline, updatedAt: now,
        } });
        return { customerId: locked?.stripeCustomerId ?? null };
      });
      if ("reuse" in decision) {
        await complete(
          req,
          checkoutOperation.id,
          "billing checkout replayed",
          decision.sessionId ?? null,
          decision.reuse!,
        );
        return { result: decision.reuse!, sessionId: decision.sessionId, reused: true };
      }
      if (decision.expire) {
        await billingProvider().expireCheckout({
          sessionId: decision.expire, idempotencyKey: stripeKey(req, checkoutOperation, "checkout-expire"),
        });
        await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
          pendingCheckoutSessionId: null, pendingCheckoutExpiresAt: null, updatedAt: new Date(),
        }).where(and(eq(organizationBillingTable.organizationId, req.tenant.organizationId), eq(organizationBillingTable.pendingCheckoutOperationId, checkoutOperation.id))));
      }
      let customerId = decision.customerId;
      if (!customerId) {
        const snapshot = await billingSnapshot(req);
        if (!snapshot) throw new Error("billing_snapshot_missing");
        await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
          stripeCustomerCreationOperationId: checkoutOperation.id, updatedAt: new Date(),
        }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
        const matches = await billingProvider().findCustomersByOrganization(req.tenant.organizationId);
        if (matches.length > 1) {
          await quarantineCustomerReference(req, "stripe_customer_count_ambiguous");
          throw new CustomerReferenceError("billing_customer_ambiguous");
        }
        const [organization] = await withTenantDb(req.tenant, (tx) => tx.select({ name: organizationsTable.name })
          .from(organizationsTable).where(eq(organizationsTable.id, req.tenant.organizationId)).limit(1));
        const customer = matches[0] ?? await billingProvider().createCustomer({
          organizationId: req.tenant.organizationId, name: organization!.name,
          idempotencyKey: `vid:customer:${req.tenant.organizationId}:generation:${snapshot.stripeCustomerGeneration}`,
        });
        customerId = customer.id;
        await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
          stripeCustomerId: customer.id, updatedAt: new Date(),
        }).where(and(eq(organizationBillingTable.organizationId, req.tenant.organizationId), eq(organizationBillingTable.pendingCheckoutOperationId, checkoutOperation.id))));
      }
      const session = await billingProvider().createCheckout({
        customerId, priceId, organizationId: req.tenant.organizationId, planCode: plan.code,
        successUrl: `${origin}/vid/settings?billing=success`, cancelUrl: `${origin}/vid/settings?billing=cancelled`,
        idempotencyKey: `vid:checkout:${req.tenant.organizationId}:${checkoutOperation.idempotencyKey}`,
      });
      const checkoutUrl = trustedStripeUrl(session.url);
      if (!checkoutUrl) throw new Error("stripe_checkout_url_invalid");
      const result = { url: checkoutUrl };
      await completeCheckout(req, checkoutOperation, session.id, result);
      return { result, sessionId: session.id, reused: false };
    });
    res.status(checkout.reused ? 200 : 201).json(CreateBillingCheckoutResponse.parse(checkout.result));
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing checkout failed", error);
    const response = publicBillingError(error, "checkout");
    const { status, ...body } = response;
    res.status(status).json(body);
  }
});

router.post("/billing/change-plan", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "change_plan", async (operation, snapshot, subscription, body) => {
    if (!body.plan || !body.interval) throw new BillingInputError("Invalid plan or interval");
    const target = await planByCode(req, body.plan);
    const current = snapshot.currentPlanId ? await planById(req, snapshot.currentPlanId) : undefined;
    const priceId = body.interval === "month" ? target?.stripeMonthlyPriceId : target?.stripeAnnualPriceId;
    if (!target || !current || !priceId) throw new BillingInputError("Plan catalog is not ready");
    if (target.sortOrder < current.sortOrder) {
      const schedule = await billingProvider().scheduleDowngrade({
        subscription, priceId, planCode: target.code, idempotencyKey: stripeKey(req, operation, "downgrade"),
      });
      if (!snapshot.periodEnd || schedule.priceId !== priceId
        || schedule.effectiveAt * 1000 !== snapshot.periodEnd.getTime()) {
        throw new Error("stripe_downgrade_schedule_mismatch");
      }
      await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
        pendingPlanId: target.id,
        pendingEffectiveAt: snapshot.periodEnd,
        pendingSubscriptionScheduleId: schedule.id,
        updatedAt: new Date(),
      }).where(and(
        eq(organizationBillingTable.organizationId, req.tenant.organizationId),
        eq(organizationBillingTable.stripeSubscriptionId, snapshot.stripeSubscriptionId!),
      )));
      return { scheduled: true, effectiveAt: snapshot.periodEnd?.toISOString() ?? null };
    }
    const changed = await billingProvider().updateSubscription({
      subscription, priceId, planCode: target.code, idempotencyKey: stripeKey(req, operation, "upgrade"),
    });
    if (changed.status === "incomplete") throw new Error("subscription_payment_incomplete");
    await reconcileOrganizationBillingUnderLock(req.tenant.organizationId, req.tenant.userId);
    return { scheduled: false, effectiveAt: new Date().toISOString() };
  });
});

router.post("/billing/cancel", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "cancel", async (operation, snapshot, subscription) => {
    await billingProvider().setCancelAtPeriodEnd({ subscriptionId: subscription.id, cancel: true, idempotencyKey: stripeKey(req, operation, "cancel") });
    await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
    return { cancelAtPeriodEnd: true };
  });
});
router.post("/billing/resume", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "resume", async (operation, snapshot, subscription) => {
    if (snapshot.periodEnd && snapshot.periodEnd <= new Date()) throw new BillingInputError("Subscription access period has ended");
    await billingProvider().setCancelAtPeriodEnd({ subscriptionId: subscription.id, cancel: false, idempotencyKey: stripeKey(req, operation, "resume") });
    await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({ cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
    return { cancelAtPeriodEnd: false };
  });
});

router.post("/billing/portal", requirePermission("workspace.manage"), async (req, res) => {
  let operation;
  try {
    const body = parseBody(req, ["idempotencyKey"], (value) => CreateBillingPortalBody.parse(value));
    operation = await claim(req, "portal", body);
    if (operation.state === "completed") {
      const url = trustedStripeUrl(operation.result?.url);
      if (!url) throw new Error("billing_portal_result_invalid");
      return void res.json(CreateBillingPortalResponse.parse({ url }));
    }
    const session = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const currentOperation = await billingOperation(req, operation!.id);
      if (!currentOperation) throw new Error("billing_operation_claim_missing");
      if (currentOperation.state === "completed") {
        const url = trustedStripeUrl(currentOperation.result?.url);
        if (!url) throw new Error("billing_portal_result_invalid");
        return { id: currentOperation.stripeObjectId, url, replayed: true };
      }
      const snapshot = await validateExistingCustomerUnderLock(req);
      if (!snapshot?.stripeCustomerId) throw new CustomerReferenceError("billing_customer_missing");
      const created = await billingProvider().createPortal({
        customerId: snapshot.stripeCustomerId, returnUrl: `${trustedRequestOrigin(req)}/vid/settings?billing=portal`,
        idempotencyKey: stripeKey(req, currentOperation, "portal"),
      });
      const url = trustedStripeUrl(created.url);
      if (!url) throw new Error("stripe_portal_url_invalid");
      await complete(req, currentOperation.id, "billing portal accessed", created.id, { url });
      return { id: created.id, url, replayed: false };
    });
    const result = { url: session.url };
    res.json(CreateBillingPortalResponse.parse(result));
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing portal failed", error);
    const response = publicBillingError(error, "portal");
    const { status, ...body } = response;
    res.status(status).json(body);
  }
});

router.get("/billing/invoices", requirePermission("workspace.manage"), async (req, res) => {
  try {
    const query = parseInvoiceQuery(req);
    const limit = query.limit;
    if (query.cursor !== undefined && !/^in_[A-Za-z0-9]+$/.test(query.cursor)) {
      throw new BillingInputError("invalid_invoice_cursor");
    }
    const cursor = query.cursor;
    const invoices = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const snapshot = await validateExistingCustomerUnderLock(req);
      if (!snapshot?.stripeCustomerId) throw new CustomerReferenceError("billing_customer_missing");
      return billingProvider().listInvoices({ customerId: snapshot.stripeCustomerId, limit, startingAfter: cursor });
    });
    res.json(ListBillingInvoicesResponse.parse({
      items: invoices.data.map((invoice) => ({
        id: invoice.id, status: invoice.status, createdAt: new Date(invoice.created * 1000),
        amountDue: invoice.amount_due, amountPaid: invoice.amount_paid, currency: invoice.currency,
        hostedInvoiceUrl: trustedStripeUrl(invoice.hosted_invoice_url),
        invoicePdf: trustedStripeUrl(invoice.invoice_pdf),
      })),
      nextCursor: invoices.has_more ? invoices.data.at(-1)?.id ?? null : null,
    }));
  } catch (error) {
    const response = publicBillingError(error, "invoices");
    const { status, ...body } = response;
    res.status(status).json(body);
  }
});

router.post("/billing/reconcile", requirePermission("workspace.manage"), async (req, res) => {
  let operation;
  try {
    const body = parseBody(req, ["idempotencyKey"], (value) =>
      ReconcileBillingSubscriptionBody.parse(value));
    operation = await claim(req, "reconcile", body);
    if (operation.state === "completed") {
      return void res.json(ReconcileBillingSubscriptionResponse.parse(operation.result));
    }
    const snapshot = await reconcileOrganizationBilling(req.tenant.organizationId, req.tenant.userId);
    const result = { status: snapshot?.status ?? "unmanaged", reconciledAt: new Date().toISOString() };
    await complete(req, operation.id, "billing reconcile completed", snapshot?.stripeSubscriptionId ?? null, result);
    res.json(ReconcileBillingSubscriptionResponse.parse(result));
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing reconcile failed", error);
    const response = publicBillingError(error, "reconcile");
    const { status, ...body } = response;
    res.status(status).json(body);
  }
});

async function billingSnapshot(req: Request) {
  return (await withTenantDb(req.tenant, (tx) => tx.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).limit(1)))[0];
}
async function billingOperation(req: Request, id: string) {
  return (await withTenantDb(req.tenant, (tx) => tx.select().from(billingOperationsTable).where(and(
    eq(billingOperationsTable.id, id),
    eq(billingOperationsTable.organizationId, req.tenant.organizationId),
  )).limit(1)))[0];
}
async function quarantineCustomerReference(req: Request, code: string) {
  await withTenantDb(req.tenant, async (tx) => {
    const [before] = await tx.select({
      status: organizationBillingTable.status,
      generation: organizationBillingTable.stripeCustomerGeneration,
    }).from(organizationBillingTable)
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId))
      .for("update")
      .limit(1);
    if (!before) return;
    await tx.update(organizationBillingTable).set({
      status: "quarantined", lastErrorCode: code, updatedAt: new Date(),
    }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId));
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId,
      actor: auditUser(req.tenant.userId),
      action: "billing.customer_reference_quarantined",
      category: "billing",
      subject: { type: "organization_billing", id: req.tenant.organizationId, label: "billing" },
      beforeState: { status: before.status, customerGeneration: before.generation },
      afterState: { status: "quarantined", customerGeneration: before.generation },
      metadata: { code },
      requestId: req.id == null ? null : String(req.id),
    });
  });
}
/** Must only be called while holding this organization's lifecycle lock. */
export async function validateExistingCustomerUnderLock(req: Request) {
  const snapshot = await billingSnapshot(req);
  if (!snapshot?.stripeCustomerId) return snapshot;
  const existingCustomerId = snapshot.stripeCustomerId;
  const customer = await billingProvider().retrieveCustomer(existingCustomerId);
  if (customer && customer.organizationId === req.tenant.organizationId) return snapshot;
  if (customer) {
    await quarantineCustomerReference(req, "stripe_customer_organization_mismatch");
    throw new CustomerReferenceError("billing_customer_mismatch");
  }
  if (snapshot.stripeSubscriptionId && snapshot.stripeSubscriptionStatus !== "canceled") {
    await quarantineCustomerReference(req, "stripe_customer_missing_for_subscription");
    throw new CustomerReferenceError("billing_customer_quarantined");
  }
  await withTenantDb(req.tenant, async (tx) => {
    const [updated] = await tx.update(organizationBillingTable).set({
      stripeCustomerId: null,
      stripeCustomerGeneration: snapshot.stripeCustomerGeneration + 1,
      stripeCustomerCreationOperationId: null,
      pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
      pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null,
      pendingPlanId: null, pendingEffectiveAt: null, pendingSubscriptionScheduleId: null,
      lastErrorCode: "stripe_customer_reference_repaired", updatedAt: new Date(),
    }).where(and(
      eq(organizationBillingTable.organizationId, req.tenant.organizationId),
      eq(organizationBillingTable.stripeCustomerId, existingCustomerId),
      eq(organizationBillingTable.stripeCustomerGeneration, snapshot.stripeCustomerGeneration),
    )).returning({
      status: organizationBillingTable.status,
      generation: organizationBillingTable.stripeCustomerGeneration,
    });
    if (updated) await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId,
      actor: auditUser(req.tenant.userId),
      action: "billing.customer_reference_repaired",
      category: "billing",
      subject: { type: "organization_billing", id: req.tenant.organizationId, label: "billing" },
      beforeState: { status: snapshot.status, customerGeneration: snapshot.stripeCustomerGeneration },
      afterState: { status: updated.status, customerGeneration: updated.generation },
      metadata: { code: "stripe_customer_reference_repaired" },
      requestId: req.id == null ? null : String(req.id),
    });
  });
  return billingSnapshot(req);
}
async function planByCode(req: Request, code: string) {
  return (await withTenantDb(req.tenant, (tx) => tx.select().from(plansTable).where(eq(plansTable.code, code)).limit(1)))[0];
}
async function planById(req: Request, id: string) {
  return (await withTenantDb(req.tenant, (tx) => tx.select().from(plansTable).where(eq(plansTable.id, id)).limit(1)))[0];
}
function stripeKey(req: Request, operation: typeof billingOperationsTable.$inferSelect, suffix: string) {
  return `vid:${suffix}:${req.tenant.organizationId}:${operation.idempotencyKey}`;
}
type SubscriptionMutationName = "change_plan" | "cancel" | "resume";
type SubscriptionMutationBody = {
  idempotencyKey: string;
  plan?: "starter" | "growth" | "scale";
  interval?: BillingInterval;
};

function parseSubscriptionMutationBody(req: Request, name: SubscriptionMutationName): SubscriptionMutationBody {
  if (name === "change_plan") {
    return parseBody(req, ["plan", "interval", "idempotencyKey"], (value) =>
      ChangeBillingPlanBody.parse(value));
  }
  const schema = name === "cancel" ? CancelBillingSubscriptionBody : ResumeBillingSubscriptionBody;
  return parseBody(req, ["idempotencyKey"], (value) => schema.parse(value));
}

function parseSubscriptionMutationResponse(name: SubscriptionMutationName, value: unknown) {
  if (name === "change_plan") return ChangeBillingPlanResponse.parse(value);
  if (name === "cancel") return CancelBillingSubscriptionResponse.parse(value);
  return ResumeBillingSubscriptionResponse.parse(value);
}

async function subscriptionMutation(
  req: Request, res: Response, name: SubscriptionMutationName,
  effect: (
    operation: typeof billingOperationsTable.$inferSelect,
    snapshot: NonNullable<Awaited<ReturnType<typeof billingSnapshot>>>,
    subscription: Awaited<ReturnType<ReturnType<typeof billingProvider>["retrieveSubscription"]>>,
    body: SubscriptionMutationBody,
  ) => Promise<Record<string, string | number | boolean | null>>,
) {
  let operation;
  try {
    const body = parseSubscriptionMutationBody(req, name);
    operation = await claim(req, name, body);
    if (operation.state === "completed") {
      return void res.json(parseSubscriptionMutationResponse(name, operation.result));
    }
    const outcome = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const currentOperation = await billingOperation(req, operation!.id);
      if (!currentOperation) throw new Error("billing_operation_claim_missing");
      if (currentOperation.state === "completed") {
        return { result: currentOperation.result ?? {}, replayed: true };
      }
      const snapshot = await reconcileOrganizationBillingUnderLock(
        req.tenant.organizationId,
        req.tenant.userId,
      );
      if (!snapshot?.stripeSubscriptionId) throw new BillingInputError("No subscription exists");
      const subscription = await billingProvider().retrieveSubscription(snapshot.stripeSubscriptionId);
      const customerId = typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
      if (customerId !== snapshot.stripeCustomerId
        || subscription.metadata.organization_id !== req.tenant.organizationId) {
        await quarantineCustomerReference(req, "stripe_subscription_organization_mismatch");
        throw new CustomerReferenceError("billing_subscription_mismatch");
      }
      const result = await effect(currentOperation, snapshot, subscription, body);
      await complete(req, currentOperation.id, `billing ${name} completed`, snapshot.stripeSubscriptionId, result);
      return { result, replayed: false };
    });
    const result = outcome.result;
    res.json(parseSubscriptionMutationResponse(name, result));
  } catch (error) {
    if (operation) await fail(req, operation.id, `billing ${name} failed`, error);
    const response = publicBillingError(error, name);
    const { status, ...body } = response;
    res.status(status).json(body);
  }
}

export default router;