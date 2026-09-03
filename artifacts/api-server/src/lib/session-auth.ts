import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import { auth } from "./auth";

export type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function getRequestSession(req: Request): Promise<AuthenticatedSession | null> {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await getRequestSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.session = session;
  next();
}

declare global {
  namespace Express {
    interface Request { session?: AuthenticatedSession }
  }
}