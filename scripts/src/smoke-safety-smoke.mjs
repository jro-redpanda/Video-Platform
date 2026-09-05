import assert from "node:assert/strict";
import { smokeEnvironment } from "./smoke-safety.mjs";

const databaseEnv = {
  NODE_ENV: "test",
  SMOKE_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/isolated_test",
  SMOKE_DATABASE_CONFIRMATION: "isolated-non-production",
  SMOKE_SESSION_SECRET: ["test", "only", "session", "fixture"].join("-"),
};

assert.equal(smokeEnvironment("database", databaseEnv).DATABASE_URL, databaseEnv.SMOKE_DATABASE_URL);
assert.throws(() => smokeEnvironment("database", {}), /SMOKE_DATABASE_CONFIRMATION/);
assert.throws(
  () => smokeEnvironment("database", { ...databaseEnv, NODE_ENV: "production" }),
  /disabled in production/,
);
assert.throws(
  () => smokeEnvironment("external-provider", databaseEnv),
  /EXTERNAL_PROVIDER_SMOKE_CONFIRMATION/,
);
assert.equal(
  smokeEnvironment("external-provider", {
    ...databaseEnv,
    EXTERNAL_PROVIDER_SMOKE_CONFIRMATION: "authorized-non-production",
  }).NODE_ENV,
  "test",
);
assert.throws(() => smokeEnvironment("storage", {}), /STORAGE_SMOKE_CONFIRMATION/);
assert.equal(smokeEnvironment("local", {}).NODE_ENV, "test");

console.log("Smoke safety guard passed.");