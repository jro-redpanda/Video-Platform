const DATABASE_CONFIRMATION = "isolated-non-production";

function rejectProductionRuntime(env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Smoke commands are disabled in production/deployment runtimes");
  }
}

function isolatedDatabaseEnvironment(env) {
  if (env.SMOKE_DATABASE_CONFIRMATION !== DATABASE_CONFIRMATION) {
    throw new Error(`SMOKE_DATABASE_CONFIRMATION=${DATABASE_CONFIRMATION} is required`);
  }
  if (!env.SMOKE_DATABASE_URL) {
    throw new Error("SMOKE_DATABASE_URL is required");
  }
  const url = new URL(env.SMOKE_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("SMOKE_DATABASE_URL must use PostgreSQL");
  }
  if (!env.SMOKE_SESSION_SECRET) {
    throw new Error("SMOKE_SESSION_SECRET with test-only key material is required");
  }
  return {
    ...env,
    NODE_ENV: "test",
    DATABASE_URL: env.SMOKE_DATABASE_URL,
    SESSION_SECRET: env.SMOKE_SESSION_SECRET,
  };
}

export function smokeEnvironment(mode, env = process.env) {
  rejectProductionRuntime(env);
  if (mode === "local") return { ...env, NODE_ENV: "test" };
  if (mode === "database") return isolatedDatabaseEnvironment(env);
  if (mode === "external-provider") {
    if (env.EXTERNAL_PROVIDER_SMOKE_CONFIRMATION !== "authorized-non-production") {
      throw new Error(
        "EXTERNAL_PROVIDER_SMOKE_CONFIRMATION=authorized-non-production is required",
      );
    }
    return isolatedDatabaseEnvironment(env);
  }
  if (mode === "storage") {
    if (env.STORAGE_SMOKE_CONFIRMATION !== "authorized-isolated-prefix") {
      throw new Error("STORAGE_SMOKE_CONFIRMATION=authorized-isolated-prefix is required");
    }
    if (!env.PRIVATE_OBJECT_DIR) {
      throw new Error("An isolated App Storage environment is required");
    }
    return { ...env, NODE_ENV: "test" };
  }
  throw new Error(`Unknown smoke mode: ${mode}`);
}