import pg from "pg";
import { runMigrations } from "stripe-replit-sync";
import { getStripeMode, getStripeSync, getUncachableStripeClient } from "./stripe-client";
import { formatOperationalError } from "./safe-error";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing Stripe catalog writes from a production runtime");
  }
  if (process.env.STRIPE_CATALOG_WRITE_CONFIRMATION !== "authorized-test-account") {
    throw new Error("Set STRIPE_CATALOG_WRITE_CONFIRMATION=authorized-test-account after approval");
  }
  if (!process.env.SMOKE_DATABASE_URL || process.env.DATABASE_URL !== process.env.SMOKE_DATABASE_URL) {
    throw new Error("Stripe test catalog writes require the dedicated SMOKE_DATABASE_URL");
  }
  if (process.env.SMOKE_DATABASE_CONFIRMATION !== "isolated-non-production") {
    throw new Error("SMOKE_DATABASE_CONFIRMATION=isolated-non-production is required");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const policyClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await policyClient.connect();
  const policy = await policyClient.query<{
    code: string;
    name: string;
    description: string;
    month: number;
    year: number;
  }>(`
    select code, name, description,
      monthly_amount_cents as month,
      annual_amount_cents as year
    from plans
    where active
      and monthly_amount_cents is not null
      and annual_amount_cents is not null
    order by sort_order
  `);
  await policyClient.end();
  if (policy.rows.length !== 3) throw new Error("Expected exactly three configured commercial billing plans");
  const definitions = policy.rows;
  const mode = await getStripeMode();
  if (mode !== "test") throw new Error("Refusing catalog writes: connected Stripe account is live mode");
  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.list({ active: true, limit: 100 });
  const relationships: Array<{ code: string; product: string; month: string; year: string }> = [];
  for (const definition of definitions) {
    const matching = products.data.filter((item) =>
      item.metadata.catalog_owner === "vid" && item.metadata.plan_code === definition.code);
    if (matching.length > 1) throw new Error(`Conflicting active Stripe products for ${definition.code}`);
    const product = matching[0] ?? await stripe.products.create({
      name: definition.name, description: definition.description,
      metadata: { catalog_owner: "vid", plan_code: definition.code },
    }, { idempotencyKey: `vid:catalog:v1:product:${definition.code}` });
    const listed = await stripe.prices.list({ product: product.id, active: true, type: "recurring", limit: 100 });
    const ids: Partial<Record<"month" | "year", string>> = {};
    for (const interval of ["month", "year"] as const) {
      const amount = definition[interval];
      const matchingPrices = listed.data.filter((price) =>
        price.metadata.catalog_owner === "vid" && price.metadata.plan_code === definition.code &&
        price.metadata.billing_interval === interval);
      if (matchingPrices.length > 1) throw new Error(`Conflicting active Stripe prices for ${definition.code}/${interval}`);
      const found = matchingPrices[0];
      if (found && (found.currency !== "usd" || found.unit_amount !== amount || found.recurring?.interval !== interval)) {
        throw new Error(`Stripe price conflicts with approved policy for ${definition.code}/${interval}`);
      }
      const price = found ?? await stripe.prices.create({
        product: product.id, currency: "usd", unit_amount: amount,
        recurring: { interval },
        metadata: { catalog_owner: "vid", plan_code: definition.code, billing_interval: interval },
      }, { idempotencyKey: `vid:catalog:v1:price:${definition.code}:${interval}:${amount}` });
      ids[interval] = price.id;
    }
    relationships.push({ code: definition.code, product: product.id, month: ids.month!, year: ids.year! });
  }
  const ownedProducts = (await stripe.products.list({ active: true, limit: 100 })).data
    .filter((item) => item.metadata.catalog_owner === "vid");
  const ownedPrices = (await stripe.prices.list({ active: true, type: "recurring", limit: 100 })).data
    .filter((item) => item.metadata.catalog_owner === "vid");
  if (ownedProducts.length !== 3 || ownedPrices.length !== 6) {
    throw new Error(`Expected exactly 3 active products and 6 active prices; found ${ownedProducts.length}/${ownedPrices.length}`);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    for (const item of relationships) await client.query(
      "update plans set stripe_product_id=$2,stripe_monthly_price_id=$3,stripe_annual_price_id=$4 where code=$1 and active",
      [item.code, item.product, item.month, item.year],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback"); throw error;
  } finally { await client.end(); }
  await runMigrations({ databaseUrl: process.env.DATABASE_URL });
  await (await getStripeSync()).syncBackfill({ object: "all" });
  console.log(`Stripe test catalog reconciled: ${relationships.map((item) => item.code).join(", ")} (3 products, 6 prices)`);
}
void main().catch((error: unknown) => {
  console.error(formatOperationalError(error));
  process.exitCode = 1;
});