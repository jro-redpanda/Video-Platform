import type Stripe from "stripe";
import type { BillingProvider, ProviderSubscription } from "./billing-provider";

/** Deterministic test double; never selected by production configuration. */
export class FakeBillingProvider implements BillingProvider {
  customers = new Map<string, { id: string; organizationId: string; deleted?: boolean }>();
  subscriptions = new Map<string, ProviderSubscription>();
  invoices = new Map<string, Stripe.Invoice[]>();
  checkouts = new Map<string, { id: string; url: string; expired: boolean }>();
  ambiguousNextCheckout = false;
  ambiguousNextCustomer = false;
  retrieveDelayMs = 0;
  failNextRetrieve = false;
  failNextUpgrade = false;
  calls: Array<{ operation: string; organizationId?: string; customerId?: string }> = [];

  async createCustomer(input: { organizationId: string; idempotencyKey: string }) {
    const existing = this.customers.get(input.idempotencyKey);
    if (existing) return existing;
    const customer = { id: `cus_fake_${this.customers.size + 1}`, organizationId: input.organizationId };
    this.customers.set(input.idempotencyKey, customer);
    this.calls.push({ operation: "customer", organizationId: input.organizationId });
    if (this.ambiguousNextCustomer) { this.ambiguousNextCustomer = false; throw new Error("fake_customer_ambiguous"); }
    return customer;
  }
  async retrieveCustomer(id: string) {
    const value = [...this.customers.values()].find((customer) => customer.id === id);
    return !value || value.deleted ? null : { id: value.id, organizationId: value.organizationId };
  }
  async findCustomersByOrganization(organizationId: string) {
    return [...this.customers.values()].filter((customer) => !customer.deleted && customer.organizationId === organizationId)
      .map((customer) => ({ id: customer.id, organizationId: customer.organizationId }));
  }
  async createCheckout(input: { customerId: string; organizationId: string; idempotencyKey: string }) {
    const existing = this.checkouts.get(input.idempotencyKey);
    if (existing) return existing;
    this.calls.push({ operation: "checkout", organizationId: input.organizationId, customerId: input.customerId });
    const checkout = { id: `cs_fake_${input.idempotencyKey}`, url: "https://checkout.stripe.test/session", expired: false };
    this.checkouts.set(input.idempotencyKey, checkout);
    if (this.ambiguousNextCheckout) { this.ambiguousNextCheckout = false; throw new Error("fake_checkout_ambiguous"); }
    return checkout;
  }
  async expireCheckout(input: { sessionId: string }) {
    const checkout = [...this.checkouts.values()].find((value) => value.id === input.sessionId);
    if (!checkout) throw new Error("fake_checkout_missing");
    checkout.expired = true;
    this.calls.push({ operation: "checkout_expire" });
  }
  async retrieveSubscription(id: string) {
    if (this.failNextRetrieve) { this.failNextRetrieve = false; throw new Error("fake_transient_provider_failure"); }
    const value = this.subscriptions.get(id);
    if (!value) throw new Error("fake_subscription_missing");
    if (this.retrieveDelayMs) await new Promise((resolve) => setTimeout(resolve, this.retrieveDelayMs));
    return value;
  }
  async listSubscriptions(customerId: string) {
    return [...this.subscriptions.values()].filter((subscription) => {
      const boundCustomerId = typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
      return boundCustomerId === customerId;
    });
  }
  async updateSubscription(input: { subscription: ProviderSubscription }) {
    if (this.failNextUpgrade) { this.failNextUpgrade = false; throw new Error("subscription_payment_incomplete"); }
    return input.subscription;
  }
  async scheduleDowngrade(input: { subscription: ProviderSubscription; priceId: string }) {
    const item = input.subscription.items.data[0] as ProviderSubscription["items"]["data"][number] & {
      current_period_end?: number;
    };
    return {
      id: `sub_sched_${input.subscription.id}`,
      priceId: input.priceId,
      effectiveAt: item.current_period_end ?? 0,
    };
  }
  async setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean }) {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    subscription.cancel_at_period_end = input.cancel;
    return subscription;
  }
  async createPortal(input: { customerId: string }) {
    return { id: `bps_${input.customerId}`, url: "https://billing.stripe.test/portal" };
  }
  async listInvoices(input: { customerId: string; limit: number }) {
    const data = (this.invoices.get(input.customerId) ?? []).slice(0, input.limit);
    return { object: "list", url: "/v1/invoices", data, has_more: false } as Stripe.ApiList<Stripe.Invoice>;
  }
}