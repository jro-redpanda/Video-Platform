import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiSpecDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(apiSpecDir, "..", "..");
const routeDirectory = path.join(root, "artifacts", "api-server", "src", "routes");
const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function normalizedRoute(value) {
  return value
    .replace(/^\/api(?=\/|$)/, "")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}") || "/";
}

function runtimeOperations(source, prefix, receiver) {
  const operations = [];
  const expression = new RegExp(
    `${receiver}\\.(${[...methods, "all"].join("|")})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  for (const match of source.matchAll(expression)) {
    const method = match[1] === "all" ? "ALL" : match[1].toUpperCase();
    operations.push(`${method} ${normalizedRoute(`${prefix}${match[2]}`)}`);
  }
  return operations;
}

const openapi = await readFile(path.join(apiSpecDir, "openapi.yaml"), "utf8");
const specOperations = new Set();
const operationIds = new Set();
let currentPath;
for (const line of openapi.split(/\r?\n/)) {
  const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1];
    continue;
  }
  if (!currentPath) continue;
  const methodMatch = /^    (get|put|post|delete|options|head|patch|trace):\s*$/.exec(line);
  if (methodMatch) {
    const operation = `${methodMatch[1].toUpperCase()} ${currentPath}`;
    assert(!specOperations.has(operation), `Duplicate OpenAPI operation: ${operation}`);
    specOperations.add(operation);
    continue;
  }
  if (/^    x-provider-owned:/.test(line)) specOperations.add(`ALL ${currentPath}`);
  const operationIdMatch = /^      operationId:\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
  if (operationIdMatch) {
    assert(!operationIds.has(operationIdMatch[1]), `Duplicate operationId: ${operationIdMatch[1]}`);
    operationIds.add(operationIdMatch[1]);
  }
}

const runtime = new Set();
for (const entry of await readdir(routeDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") continue;
  const source = await readFile(path.join(routeDirectory, entry.name), "utf8");
  const prefix = entry.name === "public.ts" ? "/public" : "";
  for (const operation of runtimeOperations(source, prefix, "router")) runtime.add(operation);
}
const appSource = await readFile(path.join(root, "artifacts", "api-server", "src", "app.ts"), "utf8");
for (const operation of runtimeOperations(appSource, "", "app")) runtime.add(operation);

assert.deepEqual(
  [...runtime].filter((operation) => !specOperations.has(operation)).sort(),
  [],
  "Runtime operations missing from OpenAPI",
);
assert.deepEqual(
  [...specOperations].filter((operation) => !runtime.has(operation)).sort(),
  [],
  "OpenAPI operations missing from runtime",
);

const generatedZod = await readFile(
  path.join(root, "lib", "api-zod", "src", "generated", "api.ts"),
  "utf8",
);
const generatedReact = await readFile(
  path.join(root, "lib", "api-client-react", "src", "generated", "api.ts"),
  "utf8",
);
assert(
  !/SelectWorkspaceBody\s*=\s*zod\.union\(\[zod\.unknown/.test(generatedZod),
  "Workspace selection generated a weak unknown union",
);
for (const internalOperation of [
  "receiveStripeWebhook",
  "receiveBunnyEncodeWebhook",
  "receiveBunnyProviderTestCallback",
]) {
  assert(!generatedZod.includes(internalOperation), `Internal operation leaked into generated clients: ${internalOperation}`);
  assert(!generatedReact.includes(internalOperation), `Internal operation leaked into generated clients: ${internalOperation}`);
}

const forbiddenPublicProperties = [
  "archiveObjectKey",
  "providerAccountId",
  "providerAssetId",
  "providerTenantSpaceId",
  "reconciliationEvidence",
  "stripeCustomerId",
  "stripeObjectId",
  "stripeSubscriptionId",
  "thumbnailGeneration",
  "thumbnailObjectKey",
];
const schemas = openapi.slice(openapi.indexOf("  schemas:"));
for (const property of forbiddenPublicProperties) {
  assert(
    !new RegExp(`^\\\\s+${property}:`, "m").test(schemas),
    `Sensitive internal property is present in a public schema: ${property}`,
  );
}

console.log(`OpenAPI contract smoke passed (${runtime.size} runtime operations).`);