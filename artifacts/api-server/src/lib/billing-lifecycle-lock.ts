import { pool } from "@workspace/db";

/** One PostgreSQL advisory-lock namespace for every billing lifecycle caller. */
export function billingLifecycleLockKey(organizationId: string) {
  return `vid:billing-lifecycle:v1:${organizationId}`;
}

export function checkoutSubscriptionConflict(
  subscriptionId: string | null,
  providerStatus: string | null,
  accessStatus: string,
) {
  if (subscriptionId) return providerStatus === "canceled" ? null : `subscription_${providerStatus ?? "exists"}`;
  return ["active", "trialing", "past_due", "incomplete", "unpaid"].includes(accessStatus)
    ? `subscription_${accessStatus}` : null;
}

/** Session lock permits durable commits while excluding reconciliation/provider races. */
export async function withBillingLifecycleLock<T>(organizationId: string, effect: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = billingLifecycleLockKey(organizationId);
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
    return await effect();
  } finally {
    try { await client.query("select pg_advisory_unlock(hashtext($1))", [key]); } finally { client.release(); }
  }
}