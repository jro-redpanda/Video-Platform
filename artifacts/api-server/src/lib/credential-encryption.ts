import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const CONTEXT = "vid/provider-credentials/aes-256-gcm/v1";

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to encrypt provider credentials");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from(CONTEXT), Buffer.from("encryption"), 32));
}

/** Versioned AES-256-GCM envelope for provider credentials. */
export function encryptProviderCredentials(credentials: Readonly<Record<string, string>>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptProviderCredentials(envelope: string): Readonly<Record<string, string>> {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Malformed provider credential envelope");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(CONTEXT));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const parsed: unknown = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.values(parsed).some((value) => typeof value !== "string")) {
      throw new Error("Invalid provider credential payload");
    }
    return parsed as Readonly<Record<string, string>>;
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid provider credential payload") throw error;
    throw new Error("Provider credential envelope failed authentication");
  }
}