import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  billingOperationsTable, db, groupPermissionsTable, membershipsTable,
  organizationBillingTable, organizationsTable, plansTable,
} from "@workspace/db";
import { billingProvider, type BillingInterval } from "../lib/billing-provider";
import { reconcileOrganizationBilling } from "../lib/billing-reconciliation";
import { requirePermission } from "../lib/permissions";
import { withTenantDb } from "../lib/tenant-db";
import { trustedRequestOrigin } from "../lib/video-embeds";
import { getUncachableStripeClient } from "../lib/stripe-client";
import { checkoutSubscriptionConflict, withBillingLifecycleLock } from "../lib/billing-lifecycle-lock";
import { auditUser, writeAuditEvent } from "../lib/audit";

const router: IRouter = Router();
const commercial = new Map([
  ["starter:month", 4900], ["starter:year", 49000],
  ["growth:month", 14900], ["growth:year", 149000],
  ["scale:month", 39900], ["scale:year", 399000],
]);
const commercialPlanCodes = ["starter", "growth", "scale"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function idempotency(req: Request) {
  const bodyValue = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  const value = typeof bodyValue === "string" ? bodyValue : undefined;
  if (!value || !uuid.test(value)) throw new BillingInputError("invalid_idempotency_key");
  return value.toLowerCase();
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
class BillingInputError extends Error {}
class CheckoutConflictError extends Error {}
class SubscriptionExistsError extends Error {
  constructor(readonly code: string) { super(code); }
}
class CustomerReferenceError extends Error {
  constructor(readonly code: string) { super(code); }
}
function hasExactKeys(value: unknown, keys: string[]) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key));
}

async function claim(req: Request, operation: string, request: unknown) {
  const expected = operation === "checkout" || operation === "change_plan"
    ? ["plan", "interval", "idempotencyKey"] : ["idempotencyKey"];
  if (!hasExactKeys(request, expected)) throw new BillingInputError("invalid_billing_request");
  const key = idempotency(req);
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

async function complete(req: Request, id: string, action: string, subjectId: string | null, result: Record<string, string | number | boolean | null>) {
  await withTenantDb(req.tenant, async (tx) => {
    await tx.update(billingOperationsTable).set({
      state: "completed", result, stripeObjectId: subjectId, completedAt: new Date(), updatedAt: new Date(),
    }).where(eq(billingOperationsTable.id, id));
    await writeAuditEvent(tx, {
      organizationId: req.tenant.organizationId, actor: auditUser(req.tenant.userId),
      action: action.replace(/\s+/g, ".").replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase(), category: "billing",
      subject: { type: "billing_operation", id, label: "completed" },
      afterState: { state: "completed" }, requestId: String(req.id),
    });
  });
}

async function fail(req: Request, id: string, action: string, error: unknown) {
  // Provider error text can contain URLs or opaque identifiers.
  const code = "billing_operation_failed";
  await withTenantDb(req.tenant, async (tx) => {
    await tx.update(billingOperationsTable).set({ state: "failed", errorCode: code, updatedAt: new Date() })
      .where(eq(billingOperationsTable.id, id));
    await writeAuditEvent(tx, {
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
      inArray(plansTable.code, commercialPlanCodes),
    )).orderBy(asc(plansTable.sortOrder));
  if (plans.length !== commercialPlanCodes.length) {
    throw new Error("billing_catalog_missing_commercial_plan");
  }
  return Promise.all(plans.map(async (plan) => {
    const entries = await Promise.all((["month", "year"] as const).map(async (interval) => {
      const priceId = interval === "month" ? plan.stripeMonthlyPriceId : plan.stripeAnnualPriceId;
      if (!priceId) throw new Error(`billing_catalog_unsynced_${plan.code}_${interval}`);
      const price = await stripe.prices.retrieve(priceId);
      const expected = commercial.get(`${plan.code}:${interval}`);
      if (!price.active || price.currency !== "usd" || price.unit_amount !== expected ||
          price.recurring?.interval !== interval || price.metadata.plan_code !== plan.code ||
          price.metadata.billing_interval !== interval) throw new Error(`billing_catalog_mismatch_${plan.code}_${interval}`);
      return { interval, amount: price.unit_amount, currency: price.currency };
    }));
    return { code: plan.code, name: plan.name, description: plan.description, entitlements: plan.entitlements, prices: entries };
  }));
}

router.get("/billing/catalog", async (_req, res) => {
  try { res.json({ plans: await catalog() }); }
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
  res.json({ ...subscription, capabilities: { canManage, canSubscribe } });
});

router.post("/billing/checkout", requirePermission("workspace.manage"), async (req, res) => {
  let operation: typeof billingOperationsTable.$inferSelect | undefined;
  try {
    const body = req.body as { plan?: string; interval?: BillingInterval };
    if (!body.plan || !["month", "year"].includes(body.interval ?? "")) throw new BillingInputError("Invalid plan or interval");
    operation = await claim(req, "checkout", body);
    if (!operation) throw new Error("billing_operation_claim_missing");
    if (operation.state === "completed") return void res.json(operation.result);
    const checkoutOperation = operation;
    const plan = await planByCode(req, body.plan);
    const priceId = body.interval === "month" ? plan?.stripeMonthlyPriceId : plan?.stripeAnnualPriceId;
    if (!plan || !plan.active || !priceId) throw new BillingInputError("Unknown or unsynced plan");
    const origin = trustedRequestOrigin(req);
    const checkout = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      await validateExistingCustomerUnderLock(req);
      const decision = await withTenantDb(req.tenant, async (tx) => {
        let [locked] = await tx.select().from(organizationBillingTable)
          .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).for("update").limit(1);
        if (locked?.stripeSubscriptionId) {
          let providerStatus = locked.stripeSubscriptionStatus;
          if (!providerStatus) {
            const authority = await billingProvider().retrieveSubscription(locked.stripeSubscriptionId);
            const customerId = typeof authority.customer === "string" ? authority.customer : authority.customer.id;
            if (customerId !== locked.stripeCustomerId || authority.metadata.organization_id !== req.tenant.organizationId) {
              throw new Error("stripe_customer_organization_mismatch");
            }
            providerStatus = authority.status as typeof locked.stripeSubscriptionStatus;
          }
          const conflict = checkoutSubscriptionConflict(locked.stripeSubscriptionId, providerStatus, locked.status);
          if (conflict) throw new SubscriptionExistsError(conflict);
          [locked] = await tx.update(organizationBillingTable).set({
            stripeSubscriptionId: null, stripeSubscriptionStatus: null,
            interval: null, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false,
            graceEndsAt: null, pendingPlanId: null, pendingEffectiveAt: null, updatedAt: new Date(),
          }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).returning();
        } else if (locked) {
          const conflict = checkoutSubscriptionConflict(null, locked.stripeSubscriptionStatus, locked.status);
          if (conflict) throw new SubscriptionExistsError(conflict);
        }
        const now = new Date();
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
        }).onConflictDoUpdate({ target: organizationBillingTable.organizationId, set: {
          pendingCheckoutPlanId: plan.id, pendingCheckoutPriceId: priceId,
          pendingCheckoutInterval: body.interval, pendingCheckoutOperationId: checkoutOperation.id, updatedAt: now,
        } });
        return { customerId: locked?.stripeCustomerId ?? null };
      });
      if ("reuse" in decision) return { result: decision.reuse!, sessionId: decision.sessionId, reused: true };
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
      if (!session.url) throw new Error("stripe_checkout_url_missing");
      const result = { url: session.url };
      await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
        pendingCheckoutSessionId: session.id, pendingCheckoutExpiresAt: new Date(Date.now() + 24 * 60 * 60_000), updatedAt: new Date(),
      }).where(and(eq(organizationBillingTable.organizationId, req.tenant.organizationId), eq(organizationBillingTable.pendingCheckoutOperationId, checkoutOperation.id))));
      return { result, sessionId: session.id, reused: false };
    });
    await complete(req, checkoutOperation.id, checkout.reused ? "billing checkout replayed" : "billing checkout completed", checkout.sessionId ?? null, checkout.result);
    res.status(checkout.reused ? 200 : 201).json(checkout.result);
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing checkout failed", error);
    res.status(error instanceof CheckoutConflictError || error instanceof SubscriptionExistsError || error instanceof CustomerReferenceError ? 409 : error instanceof BillingInputError ? 422 : 502).json({
      error: error instanceof Error ? error.message : "Checkout failed",
      code: error instanceof CustomerReferenceError ? error.code : error instanceof SubscriptionExistsError ? error.code : error instanceof CheckoutConflictError ? "checkout_in_progress" : error instanceof BillingInputError ? "invalid_billing_request" : "billing_provider_failed",
    });
  }
});

router.post("/billing/change-plan", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "change_plan", async (operation, snapshot) => {
    const body = req.body as { plan?: string; interval?: BillingInterval };
    if (!body.plan || !["month", "year"].includes(body.interval ?? "")) throw new BillingInputError("Invalid plan or interval");
    const target = await planByCode(req, body.plan);
    const current = snapshot.currentPlanId ? await planById(req, snapshot.currentPlanId) : undefined;
    const priceId = body.interval === "month" ? target?.stripeMonthlyPriceId : target?.stripeAnnualPriceId;
    if (!target || !current || !priceId) throw new BillingInputError("Plan catalog is not ready");
    const subscription = await billingProvider().retrieveSubscription(snapshot.stripeSubscriptionId!);
    if (target.sortOrder < current.sortOrder) {
      const schedule = await billingProvider().scheduleDowngrade({
        subscription, priceId, planCode: target.code, idempotencyKey: stripeKey(req, operation, "downgrade"),
      });
      await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
        pendingPlanId: target.id, pendingEffectiveAt: snapshot.periodEnd, updatedAt: new Date(),
      }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
      return { scheduled: true, effectiveAt: snapshot.periodEnd?.toISOString() ?? null, reference: schedule.id };
    }
    const changed = await billingProvider().updateSubscription({
      subscription, priceId, planCode: target.code, idempotencyKey: stripeKey(req, operation, "upgrade"),
    });
    if (changed.status === "incomplete") throw new Error("subscription_payment_incomplete");
    await reconcileOrganizationBilling(req.tenant.organizationId, req.tenant.userId);
    return { scheduled: false, effectiveAt: new Date().toISOString(), reference: changed.id };
  });
});

router.post("/billing/cancel", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "cancel", async (operation, snapshot) => {
    await billingProvider().setCancelAtPeriodEnd({ subscriptionId: snapshot.stripeSubscriptionId!, cancel: true, idempotencyKey: stripeKey(req, operation, "cancel") });
    await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
    return { cancelAtPeriodEnd: true };
  });
});
router.post("/billing/resume", requirePermission("workspace.manage"), async (req, res) => {
  await subscriptionMutation(req, res, "resume", async (operation, snapshot) => {
    if (snapshot.periodEnd && snapshot.periodEnd <= new Date()) throw new BillingInputError("Subscription access period has ended");
    await billingProvider().setCancelAtPeriodEnd({ subscriptionId: snapshot.stripeSubscriptionId!, cancel: false, idempotencyKey: stripeKey(req, operation, "resume") });
    await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({ cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
    return { cancelAtPeriodEnd: false };
  });
});

router.post("/billing/portal", requirePermission("workspace.manage"), async (req, res) => {
  let operation;
  try {
    operation = await claim(req, "portal", req.body);
    if (operation.state === "completed") return void res.json(operation.result);
    const session = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const snapshot = await validateExistingCustomerUnderLock(req);
      if (!snapshot?.stripeCustomerId) throw new CustomerReferenceError("billing_customer_missing");
      return billingProvider().createPortal({
        customerId: snapshot.stripeCustomerId, returnUrl: `${trustedRequestOrigin(req)}/vid/settings?billing=portal`,
        idempotencyKey: stripeKey(req, operation!, "portal"),
      });
    });
    const result = { url: session.url };
    await complete(req, operation.id, "billing portal accessed", session.id, result);
    res.json(result);
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing portal failed", error);
    res.status(error instanceof CustomerReferenceError ? 409 : error instanceof BillingInputError ? 422 : 502).json({
      error: error instanceof Error ? error.message : "Portal failed",
      code: error instanceof CustomerReferenceError ? error.code : "billing_portal_failed",
    });
  }
});

router.get("/billing/invoices", requirePermission("workspace.manage"), async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const cursor = typeof req.query.cursor === "string" && /^in_[A-Za-z0-9]+$/.test(req.query.cursor) ? req.query.cursor : undefined;
    const invoices = await withBillingLifecycleLock(req.tenant.organizationId, async () => {
      const snapshot = await validateExistingCustomerUnderLock(req);
      if (!snapshot?.stripeCustomerId) throw new CustomerReferenceError("billing_customer_missing");
      return billingProvider().listInvoices({ customerId: snapshot.stripeCustomerId, limit, startingAfter: cursor });
    });
    res.json({
      items: invoices.data.map((invoice) => ({
        id: invoice.id, status: invoice.status, createdAt: new Date(invoice.created * 1000),
        amountDue: invoice.amount_due, amountPaid: invoice.amount_paid, currency: invoice.currency,
        hostedInvoiceUrl: invoice.hosted_invoice_url, invoicePdf: invoice.invoice_pdf,
      })),
      nextCursor: invoices.has_more ? invoices.data.at(-1)?.id ?? null : null,
    });
  } catch (error) {
    res.status(error instanceof CustomerReferenceError ? 409 : 502).json({
      error: error instanceof Error ? error.message : "Invoices unavailable",
      code: error instanceof CustomerReferenceError ? error.code : "billing_invoices_failed",
    });
  }
});

router.post("/billing/reconcile", requirePermission("workspace.manage"), async (req, res) => {
  let operation;
  try {
    operation = await claim(req, "reconcile", req.body);
    if (operation.state === "completed") return void res.json(operation.result);
    const snapshot = await reconcileOrganizationBilling(req.tenant.organizationId, req.tenant.userId);
    const result = { status: snapshot?.status ?? "unmanaged", reconciledAt: new Date().toISOString() };
    await complete(req, operation.id, "billing reconcile completed", snapshot?.stripeSubscriptionId ?? null, result);
    res.json(result);
  } catch (error) {
    if (operation) await fail(req, operation.id, "billing reconcile failed", error);
    res.status(502).json({ error: "Billing reconciliation failed" });
  }
});

async function billingSnapshot(req: Request) {
  return (await withTenantDb(req.tenant, (tx) => tx.select().from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)).limit(1)))[0];
}
async function quarantineCustomerReference(req: Request, code: string) {
  await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
    status: "quarantined", lastErrorCode: code, updatedAt: new Date(),
  }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
}
/** Must only be called while holding this organization's lifecycle lock. */
export async function validateExistingCustomerUnderLock(req: Request) {
  const snapshot = await billingSnapshot(req);
  if (!snapshot?.stripeCustomerId) return snapshot;
  const customer = await billingProvider().retrieveCustomer(snapshot.stripeCustomerId);
  if (customer && customer.organizationId === req.tenant.organizationId) return snapshot;
  if (customer) {
    await quarantineCustomerReference(req, "stripe_customer_organization_mismatch");
    throw new CustomerReferenceError("billing_customer_mismatch");
  }
  if (snapshot.stripeSubscriptionId && snapshot.stripeSubscriptionStatus !== "canceled") {
    await quarantineCustomerReference(req, "stripe_customer_missing_for_subscription");
    throw new CustomerReferenceError("billing_customer_quarantined");
  }
  await withTenantDb(req.tenant, (tx) => tx.update(organizationBillingTable).set({
    stripeCustomerId: null,
    stripeCustomerGeneration: snapshot.stripeCustomerGeneration + 1,
    stripeCustomerCreationOperationId: null,
    pendingCheckoutSessionId: null, pendingCheckoutPlanId: null, pendingCheckoutPriceId: null,
    pendingCheckoutInterval: null, pendingCheckoutExpiresAt: null, pendingCheckoutOperationId: null,
    lastErrorCode: "stripe_customer_reference_repaired", updatedAt: new Date(),
  }).where(eq(organizationBillingTable.organizationId, req.tenant.organizationId)));
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
async function subscriptionMutation(
  req: Request, res: Response, name: string,
  effect: (operation: typeof billingOperationsTable.$inferSelect, snapshot: NonNullable<Awaited<ReturnType<typeof billingSnapshot>>>) => Promise<Record<string, string | number | boolean | null>>,
) {
  let operation;
  try {
    operation = await claim(req, name, req.body ?? {});
    if (operation.state === "completed") return void res.json(operation.result);
    const snapshot = await billingSnapshot(req);
    if (!snapshot?.stripeSubscriptionId) throw new BillingInputError("No subscription exists");
    const result = await effect(operation, snapshot);
    await complete(req, operation.id, `billing ${name} completed`, snapshot.stripeSubscriptionId, result);
    res.json(result);
  } catch (error) {
    if (operation) await fail(req, operation.id, `billing ${name} failed`, error);
    res.status(error instanceof BillingInputError ? 422 : 502).json({ error: error instanceof Error ? error.message : "Billing operation failed" });
  }
}

export default router;