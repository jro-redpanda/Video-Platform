import { existsSync } from "node:fs";

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  throw new Error("This workspace requires pnpm");
}

const conflictingLocks = ["package-lock.json", "yarn.lock"].filter(existsSync);
if (conflictingLocks.length > 0) {
  throw new Error(
    `Remove conflicting lockfiles before installing: ${conflictingLocks.join(", ")}`,
  );
}