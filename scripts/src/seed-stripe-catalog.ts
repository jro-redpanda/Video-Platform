import pg from "pg";
import { runMigrations } from "stripe-replit-sync";
import { getStripeMode, getStripeSync, getUncachableStripeClient } from "./stripe-client";

const definitions = [
  { code: "starter", name: "Starter", description: "For small video libraries", month: 4900, year: 49000 },
  { code: "growth", name: "Growth", description: "For growing video teams", month: 14900, year: 149000 },
  { code: "scale", name: "Scale", description: "For high-volume video operations", month: 39900, year: 399000 },
] as const;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
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
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });