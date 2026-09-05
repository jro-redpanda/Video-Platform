import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { smokeEnvironment } from "./smoke-safety.mjs";

const [mode, target, ...flags] = process.argv.slice(2);
if (!mode || !target) {
  throw new Error("Usage: run-smoke.mjs <mode> <target> [--skip-build] [--strip-types]");
}

const allowedFlags = new Set(["--skip-build", "--strip-types"]);
for (const flag of flags) {
  if (!allowedFlags.has(flag)) throw new Error(`Unknown smoke launcher flag: ${flag}`);
}

const targetPath = resolve(process.cwd(), target);
if (!/\.(?:mjs|js|ts)$/.test(targetPath)) {
  throw new Error("Smoke target must be a JavaScript or TypeScript file");
}

const env = smokeEnvironment(mode, process.env);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!flags.includes("--skip-build")) run("pnpm", ["run", "build"]);
run(process.execPath, [
  ...(flags.includes("--strip-types") ? ["--experimental-strip-types"] : []),
  targetPath,
]);