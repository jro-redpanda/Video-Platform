import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

async function credentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL ? `depl ${process.env.WEB_REPL_RENEWAL}` : undefined;
  if (!hostname || !token) throw new Error("Stripe connector credentials are unavailable");
  const response = await fetch(`https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: token }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Stripe credential fetch failed (${response.status})`);
  const json = await response.json() as { items?: Array<{ settings?: Record<string, string> }> };
  const settings = json.items?.[0]?.settings;
  const secretKey = settings?.secret_key ?? settings?.secret;
  if (!secretKey) throw new Error("Stripe connector is not connected");
  return {
    secretKey,
    webhookSecret: settings?.webhook_secret ?? settings?.webhookSecret,
  };
}

export async function getUncachableStripeClient() {
  return new Stripe((await credentials()).secretKey);
}
export async function getStripeMode() {
  const key = (await credentials()).secretKey;
  if (key.startsWith("sk_test_")) return "test" as const;
  if (key.startsWith("sk_live_")) return "live" as const;
  throw new Error("Unrecognized Stripe key mode");
}
export async function getStripeSync() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const value = await credentials();
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL },
    stripeSecretKey: value.secretKey, stripeWebhookSecret: value.webhookSecret ?? "",
  });
}