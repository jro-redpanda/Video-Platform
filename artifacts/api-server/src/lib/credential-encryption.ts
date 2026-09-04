import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const CONTEXT = "vid/provider-credentials/aes-256-gcm/v1";
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PLAINTEXT_BYTES = 49_000;
const MAX_CREDENTIAL_FIELDS = 32;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to encrypt provider credentials");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from(CONTEXT), Buffer.from("encryption"), 32));
}

/** Versioned AES-256-GCM envelope for provider credentials. */
export function encryptProviderCredentials(credentials: Readonly<Record<string, string>>): string {
  validateCredentialPayload(credentials);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Provider credential payload is too large");
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptProviderCredentials(envelope: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Malformed provider credential envelope");
  }
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Malformed provider credential envelope");
  }
  try {
    const iv = decodeCanonicalBase64Url(parts[1]!);
    const authTag = decodeCanonicalBase64Url(parts[2]!);
    const ciphertext = decodeCanonicalBase64Url(parts[3]!);
    if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0
      || ciphertext.length > MAX_ENVELOPE_BYTES) {
      throw new Error("Malformed provider credential envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(Buffer.from(CONTEXT));
    decipher.setAuthTag(authTag);
    const parsed: unknown = JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8"));
    validateCredentialPayload(parsed);
    return parsed as Readonly<Record<string, string>>;
  } catch (error) {
    if (error instanceof Error && (
      error.message === "Invalid provider credential payload"
      || error.message === "Malformed provider credential envelope"
    )) throw error;
    throw new Error("Provider credential envelope failed authentication");
  }
}

function decodeCanonicalBase64Url(value: string) {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Malformed provider credential envelope");
  }
  return decoded;
}

function validateCredentialPayload(value: unknown): asserts value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider credential payload");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_CREDENTIAL_FIELDS || entries.some(
    ([name, secret]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
      || typeof secret !== "string"
      || secret.length === 0
      || Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_VALUE_BYTES,
  )) {
    throw new Error("Invalid provider credential payload");
  }
}