import { domainToASCII } from "node:url";

type RuntimeEnvironment = "development" | "test" | "production";

function requiredConfig(
  env: NodeJS.ProcessEnv,
  key: "PRODUCT_NAME" | "VID_APP_DOMAIN" | "SESSION_SECRET" | "DATABASE_URL",
) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "development" || value === "test" || value === "production") return value;
  throw new Error("NODE_ENV must be one of development, test, or production");
}

export function parsePort(value: string | undefined): number {
  if (!value?.trim()) throw new Error("PORT environment variable is required");
  if (!/^\d+$/.test(value.trim())) throw new Error("PORT must be an integer between 1 and 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseHostname(value: string, key: string): string {
  const hostname = value.trim().replace(/\.$/, "").toLowerCase();
  const ascii = domainToASCII(hostname);
  if (
    !ascii
    || ascii.length > 253
    || ascii.includes("://")
    || ascii.includes("/")
    || ascii.includes(":")
    || ascii.split(".").some((label) =>
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    throw new Error(`${key} must be a valid hostname without a scheme, path, or port`);
  }
  return ascii;
}

function validateDatabaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
}

function validateLogLevel(value: string | undefined) {
  if (
    value
    && !["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(value)
  ) {
    throw new Error("LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, or silent");
  }
}

/**
 * Validates every prerequisite before startup performs database, provider, or
 * worker side effects. Secret values are deliberately omitted from the result
 * so callers cannot accidentally log them.
 */
export function loadStartupConfig(env: NodeJS.ProcessEnv) {
  const nodeEnv = parseEnvironment(env.NODE_ENV);
  const port = parsePort(env.PORT);
  const productName = requiredConfig(env, "PRODUCT_NAME");
  if (productName.length > 100) throw new Error("PRODUCT_NAME must be at most 100 characters");
  parseHostname(requiredConfig(env, "VID_APP_DOMAIN"), "VID_APP_DOMAIN");

  const sessionSecret = requiredConfig(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

  const databaseUrl = requiredConfig(env, "DATABASE_URL");
  validateDatabaseUrl(databaseUrl);
  validateLogLevel(env.LOG_LEVEL);

  if (env.STRIPE_SYNC_IN_TEST && !["true", "false"].includes(env.STRIPE_SYNC_IN_TEST)) {
    throw new Error("STRIPE_SYNC_IN_TEST must be true or false when provided");
  }
  const stripeSyncEnabled = nodeEnv !== "test" || env.STRIPE_SYNC_IN_TEST === "true";
  if (stripeSyncEnabled) {
    const stripeDomain = env.REPLIT_DOMAINS?.split(",")[0]?.trim();
    if (!stripeDomain) {
      throw new Error("REPLIT_DOMAINS is required when Stripe synchronization is enabled");
    }
    parseHostname(stripeDomain, "REPLIT_DOMAINS");

    const connectorHostname = env.REPLIT_CONNECTORS_HOSTNAME?.trim();
    if (!connectorHostname) {
      throw new Error(
        "REPLIT_CONNECTORS_HOSTNAME is required when Stripe synchronization is enabled",
      );
    }
    parseHostname(connectorHostname, "REPLIT_CONNECTORS_HOSTNAME");
    if (!env.REPL_IDENTITY?.trim() && !env.WEB_REPL_RENEWAL?.trim()) {
      throw new Error(
        "Replit workload identity is required when Stripe synchronization is enabled",
      );
    }
  }

  return Object.freeze({ nodeEnv, port });
}

export const runtimeConfig = Object.freeze({
  productName: requiredConfig(process.env, "PRODUCT_NAME"),
  appDomain: parseHostname(
    requiredConfig(process.env, "VID_APP_DOMAIN"),
    "VID_APP_DOMAIN",
  ),
});