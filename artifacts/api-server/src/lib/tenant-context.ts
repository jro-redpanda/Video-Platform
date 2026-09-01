import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import { db, membershipsTable } from "@workspace/db";
import { developmentTenant } from "./bootstrap";
import { auth } from "./auth";

export type TenantContext = {
  organizationId: string;
  userId: string;
};

declare global {
  namespace Express {
    interface Request {
      tenant: TenantContext;
    }
  }
}

export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let [membership] = await db.select({
    organizationId: membershipsTable.organizationId,
  }).from(membershipsTable).where(and(
    eq(membershipsTable.userId, session.user.id),
    eq(membershipsTable.status, "active"),
  )).limit(1);

  if (!membership && process.env.NODE_ENV !== "production") {
    await db.insert(membershipsTable).values({
      organizationId: developmentTenant.organizationId,
      userId: session.user.id,
      groupId: developmentTenant.groupId,
      status: "active",
    }).onConflictDoNothing();
    membership = { organizationId: developmentTenant.organizationId };
  }

  if (!membership) {
    res.status(403).json({ error: "No active workspace membership" });
    return;
  }

  req.tenant = {
    organizationId: membership.organizationId,
    userId: session.user.id,
  };
  next();
}