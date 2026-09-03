import { Step7SmokeVideoProvider } from "@workspace/providers/test-only";
import { videoProviders } from "./provider-registry";

/** Installs the deterministic adapter only from explicit smoke-test entrypoints. */
export function registerStep7SmokeProvider(): Step7SmokeVideoProvider {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The step7-smoke provider can only be registered in the test runtime");
  }
  const current = videoProviders.resolve("step7-smoke");
  if (current instanceof Step7SmokeVideoProvider) return current;
  const provider = new Step7SmokeVideoProvider();
  videoProviders.register(provider);
  return provider;
}