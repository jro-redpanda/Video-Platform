import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiSpecDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(apiSpecDir, "..", "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "vid-codegen-"));

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function assertTreesEqual(expectedDirectory, actualDirectory, label) {
  const expectedFiles = await filesBelow(expectedDirectory);
  const actualFiles = await filesBelow(actualDirectory);
  assert.deepEqual(actualFiles, expectedFiles, `${label} generated file list differs`);
  for (const relative of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(expectedDirectory, relative)),
      readFile(path.join(actualDirectory, relative)),
    ]);
    assert.deepEqual(actual, expected, `${label} generated file differs: ${relative}`);
  }
}

try {
  const temporaryClientSource = path.join(temporaryRoot, "api-client-react", "src");
  await cp(
    path.join(root, "lib", "api-client-react", "src", "custom-fetch.ts"),
    path.join(temporaryClientSource, "custom-fetch.ts"),
    { recursive: false },
  );
  const generation = spawnSync(
    "pnpm",
    ["exec", "orval", "--config", "./orval.config.ts"],
    {
      cwd: apiSpecDir,
      encoding: "utf8",
      env: { ...process.env, ORVAL_OUTPUT_ROOT: temporaryRoot },
    },
  );
  if (generation.status !== 0) {
    process.stderr.write(generation.stdout ?? "");
    process.stderr.write(generation.stderr ?? "");
    throw new Error(`temporary OpenAPI generation exited with ${generation.status}`);
  }
  await assertTreesEqual(
    path.join(temporaryRoot, "api-client-react", "src", "generated"),
    path.join(root, "lib", "api-client-react", "src", "generated"),
    "React client",
  );
  await assertTreesEqual(
    path.join(temporaryRoot, "api-zod", "src", "generated"),
    path.join(root, "lib", "api-zod", "src", "generated"),
    "Zod",
  );
  console.log("OpenAPI generated sources are reproducible.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}