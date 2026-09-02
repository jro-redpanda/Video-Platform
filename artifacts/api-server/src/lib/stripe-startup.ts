import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripe-client";

/** Provider-owned migrations must precede StripeSync construction. */
export async function initializeStripeSync() {
  if (process.env.NODE_ENV === "test" && process.env.STRIPE_SYNC_IN_TEST !== "true") return;
  const databaseUrl = process.env.DATABASE_URL;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for StripeSync");
  if (!domain) throw new Error("REPLIT_DOMAINS is required to configure the managed Stripe webhook");
  await runMigrations({ databaseUrl });
  const sync = await getStripeSync();
  await sync.findOrCreateManagedWebhook(`https://${domain}/api/stripe/webhook`);
  await sync.syncBackfill({ object: "all" });
}