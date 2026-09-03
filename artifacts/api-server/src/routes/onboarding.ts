import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import {
  CreateOnboardingWorkspaceBody,
  CreateOnboardingWorkspaceResponse,
  GetOnboardingResponse,
  RetryOnboardingBody,
  RetryOnboardingResponse,
} from "@workspace/api-zod";
import { auth } from "../lib/auth";
import {
  createFirstWorkspace,
  getOnboardingState,
  OnboardingConflictError,
  OnboardingForbiddenError,
  OnboardingValidationError,
  retryWorkspaceOnboarding,
} from "../lib/workspace-onboarding";
import { enqueueOnboardingDispatchWakeup } from "../lib/jobs";

declare global {
  namespace Express {
    interface Request {
      onboardingUserId?: string;
    }
  }
}

const router: IRouter = Router();

async function authenticateOnboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.onboardingUserId = session.user.id;
  next();
}

router.use("/onboarding", authenticateOnboarding);

router.get("/onboarding", async (req, res): Promise<void> => {
  res.json(GetOnboardingResponse.parse(await getOnboardingState(req.onboardingUserId!)));
});

router.post("/onboarding/workspaces", async (req, res): Promise<void> => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
    || Object.keys(req.body).some((key) => key !== "name" && key !== "slug")) {
    res.status(400).json({ error: "Invalid workspace name or slug" });
    return;
  }
  const parsed = CreateOnboardingWorkspaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workspace name or slug" });
    return;
  }
  try {
    await createFirstWorkspace(req.onboardingUserId!, parsed.data);
    void enqueueOnboardingDispatchWakeup().catch(() => {
      req.log.warn("Onboarding dispatch wake-up failed; durable scanner will retry");
    });
    res.status(202).json(CreateOnboardingWorkspaceResponse.parse(
      await getOnboardingState(req.onboardingUserId!),
    ));
  } catch (error) {
    if (error instanceof OnboardingValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof OnboardingConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/onboarding/retry", async (req, res): Promise<void> => {
  if (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body)
    || Object.keys(req.body).some((key) => key !== "workspaceId"))) {
    res.status(400).json({ error: "Invalid workspace reference" });
    return;
  }
  const parsed = RetryOnboardingBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workspace reference" });
    return;
  }
  try {
    const state = await retryWorkspaceOnboarding(req.onboardingUserId!, parsed.data.workspaceId);
    void enqueueOnboardingDispatchWakeup().catch(() => {
      req.log.warn("Onboarding retry dispatch wake-up failed; durable scanner will retry");
    });
    res.status(202).json(RetryOnboardingResponse.parse(state));
  } catch (error) {
    if (error instanceof OnboardingForbiddenError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof OnboardingConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;