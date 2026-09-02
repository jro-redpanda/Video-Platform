import { getStripeSync } from "./stripe-client";

export async function processStripeWebhook(payload: Buffer, signature: string) {
  if (!Buffer.isBuffer(payload)) throw new Error("Stripe webhook payload must be a raw Buffer");
  await (await getStripeSync()).processWebhook(payload, signature);
}