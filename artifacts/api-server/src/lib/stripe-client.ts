import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

type StripeCredentials = { secretKey: string; webhookSecret?: string };

/** Fetches rotating connector credentials for each use. Never cache or log these values. */
async function getStripeCredentials(): Promise<StripeCredentials> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL ? `depl ${process.env.WEB_REPL_RENEWAL}` : undefined;
  if (!hostname || !token) throw new Error("Stripe connector credentials are unavailable");
  const response = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: token }, signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error(`Stripe credential fetch failed (${response.status})`);
  const body = await response.json() as { items?: Array<{ settings?: Record<string, string> }> };
  const settings = body.items?.[0]?.settings;
  const secretKey = settings?.secret_key ?? settings?.secret;
  if (!secretKey) throw new Error("Stripe connector is not connected");
  return {
    secretKey,
    webhookSecret: settings?.webhook_secret ?? settings?.webhookSecret,
  };
}

export async function getUncachableStripeClient() {
  return new Stripe((await getStripeCredentials()).secretKey);
}

export async function getStripeSync() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const credentials = await getStripeCredentials();
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: credentials.secretKey,
    stripeWebhookSecret: credentials.webhookSecret ?? "",
    revalidateObjectsViaStripeApi: ["customer", "invoice", "price", "product", "subscription", "subscription_schedule"],
  });
}

export async function stripeMode(): Promise<"test" | "live"> {
  const { secretKey } = await getStripeCredentials();
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  throw new Error("Unrecognized Stripe credential mode");
}