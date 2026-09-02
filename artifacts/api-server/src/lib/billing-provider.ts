import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripe-client";

export type BillingInterval = "month" | "year";
export type ProviderSubscription = Stripe.Subscription;

export interface BillingProvider {
  createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }): Promise<{ id: string }>;
  retrieveCustomer(id: string): Promise<{ id: string; organizationId: string } | null>;
  findCustomersByOrganization(organizationId: string): Promise<Array<{ id: string; organizationId: string }>>;
  createCheckout(input: { customerId: string; priceId: string; organizationId: string; planCode: string; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string | null }>;
  expireCheckout(input: { sessionId: string; idempotencyKey: string }): Promise<void>;
  retrieveSubscription(id: string): Promise<ProviderSubscription>;
  listSubscriptions(customerId: string): Promise<ProviderSubscription[]>;
  updateSubscription(input: { subscription: ProviderSubscription; priceId: string; planCode: string; idempotencyKey: string }): Promise<ProviderSubscription>;
  scheduleDowngrade(input: { subscription: ProviderSubscription; priceId: string; planCode: string; idempotencyKey: string }): Promise<{ id: string }>;
  setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean; idempotencyKey: string }): Promise<ProviderSubscription>;
  createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string }>;
  listInvoices(input: { customerId: string; limit: number; startingAfter?: string }): Promise<Stripe.ApiList<Stripe.Invoice>>;
}

function onlyItem(subscription: Stripe.Subscription) {
  if (subscription.items.data.length !== 1) throw new Error("subscription_item_count_ambiguous");
  return subscription.items.data[0]!;
}

export class StripeBillingProvider implements BillingProvider {
  async createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }) {
    return (await getUncachableStripeClient()).customers.create({
      name: input.name, metadata: { organization_id: input.organizationId },
    }, { idempotencyKey: input.idempotencyKey });
  }
  async retrieveCustomer(id: string) {
    try {
      const customer = await (await getUncachableStripeClient()).customers.retrieve(id);
      if (customer.deleted) return null;
      return { id: customer.id, organizationId: customer.metadata.organization_id ?? "" };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "resource_missing") return null;
      throw error;
    }
  }
  async findCustomersByOrganization(organizationId: string) {
    const result = await (await getUncachableStripeClient()).customers.search({
      query: `metadata['organization_id']:'${organizationId.replaceAll("'", "\\'")}'`, limit: 10,
    });
    return result.data.filter((customer) => !customer.deleted && customer.metadata.organization_id === organizationId)
      .map((customer) => ({ id: customer.id, organizationId }));
  }
  async createCheckout(input: { customerId: string; priceId: string; organizationId: string; planCode: string; successUrl: string; cancelUrl: string; idempotencyKey: string }) {
    return (await getUncachableStripeClient()).checkout.sessions.create({
      mode: "subscription", customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      allow_promotion_codes: false,
      success_url: input.successUrl, cancel_url: input.cancelUrl,
      client_reference_id: input.organizationId,
      metadata: { organization_id: input.organizationId, plan_code: input.planCode },
      subscription_data: { metadata: { organization_id: input.organizationId, plan_code: input.planCode } },
    }, { idempotencyKey: input.idempotencyKey });
  }
  async expireCheckout(input: { sessionId: string; idempotencyKey: string }) {
    // Stripe's typed expire endpoint does not expose request options. The durable
    // replacement claim prevents a second expiry/create while this call is repaired.
    await (await getUncachableStripeClient()).checkout.sessions.expire(input.sessionId);
  }
  async retrieveSubscription(id: string) {
    return (await getUncachableStripeClient()).subscriptions.retrieve(id, { expand: ["schedule"] });
  }
  async listSubscriptions(customerId: string) {
    return (await getUncachableStripeClient()).subscriptions.list({ customer: customerId, status: "all", limit: 10 }).then((value) => value.data);
  }
  async updateSubscription(input: { subscription: Stripe.Subscription; priceId: string; planCode: string; idempotencyKey: string }) {
    return (await getUncachableStripeClient()).subscriptions.update(input.subscription.id, {
      items: [{ id: onlyItem(input.subscription).id, price: input.priceId }],
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      metadata: { ...input.subscription.metadata, plan_code: input.planCode },
    }, { idempotencyKey: input.idempotencyKey });
  }
  async scheduleDowngrade(input: { subscription: Stripe.Subscription; priceId: string; planCode: string; idempotencyKey: string }) {
    const stripe = await getUncachableStripeClient();
    const item = onlyItem(input.subscription) as Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number };
    const start = item.current_period_start ?? input.subscription.billing_cycle_anchor;
    const end = item.current_period_end;
    if (!end) throw new Error("subscription_period_missing");
    let scheduleId = typeof input.subscription.schedule === "string" ? input.subscription.schedule : input.subscription.schedule?.id;
    if (!scheduleId) {
      scheduleId = (await stripe.subscriptionSchedules.create(
        { from_subscription: input.subscription.id },
        { idempotencyKey: `${input.idempotencyKey}:create` },
      )).id;
    }
    return stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "release",
      phases: [
        { start_date: start, end_date: end, items: [{ price: onlyItem(input.subscription).price.id, quantity: 1 }] },
        { start_date: end, items: [{ price: input.priceId, quantity: 1 }], metadata: { plan_code: input.planCode } },
      ],
    }, { idempotencyKey: `${input.idempotencyKey}:update` });
  }
  async setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean; idempotencyKey: string }) {
    return (await getUncachableStripeClient()).subscriptions.update(input.subscriptionId, {
      cancel_at_period_end: input.cancel,
    }, { idempotencyKey: input.idempotencyKey });
  }
  async createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }) {
    return (await getUncachableStripeClient()).billingPortal.sessions.create({
      customer: input.customerId, return_url: input.returnUrl,
    }, { idempotencyKey: input.idempotencyKey });
  }
  async listInvoices(input: { customerId: string; limit: number; startingAfter?: string }) {
    return (await getUncachableStripeClient()).invoices.list({
      customer: input.customerId, limit: input.limit, starting_after: input.startingAfter,
    });
  }
}

let provider: BillingProvider = new StripeBillingProvider();
export const billingProvider = () => provider;
export const injectBillingProviderForTest = (value: BillingProvider) => { provider = value; };