import type { NextFunction, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { customDomainsTable, membershipsTable, organizationsTable } from "@workspace/db";
import { getRequestSession } from "./session-auth";
import {
  appSubdomainForHost,
  chooseWorkspace,
  cookieName,
  decodeWorkspaceSelection,
  normalizeRequestHost,
} from "./workspace-selection";
import { runtimeConfig } from "./config";
import { withUserDb } from "./tenant-db";

export type TenantContext = {
  organizationId: string;
  userId: string;
};

export type AvailableWorkspace = {
  id: string;
  name: string;
  slug: string;
};

declare global {
  namespace Express {
    interface Request {
      tenant: TenantContext;
    }
  }
}

export async function resolveWorkspaceForRequest(
  req: Request,
  userId: string,
): Promise<{ workspaces: AvailableWorkspace[]; current?: AvailableWorkspace }> {
  const selectedId = decodeWorkspaceSelection(req.cookies?.[cookieName], userId);
  const host = normalizeRequestHost(req.hostname);
  return withUserDb(userId, async (tx) => {
    const memberships = await tx.select({
      id: membershipsTable.organizationId,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
    }).from(membershipsTable).innerJoin(organizationsTable, eq(organizationsTable.id, membershipsTable.organizationId)).where(and(
      eq(membershipsTable.userId, userId),
      eq(membershipsTable.status, "active"),
      eq(organizationsTable.status, "active"),
    )).orderBy(asc(organizationsTable.slug), asc(organizationsTable.id));

    let organizationId: string | undefined;
    if (host && memberships.length) {
      const domains = await tx.select({ organizationId: customDomainsTable.organizationId })
        .from(customDomainsTable).where(and(eq(customDomainsTable.hostname, host), eq(customDomainsTable.lifecycleState, "verified")));
      organizationId = domains.find((domain) => memberships.some((workspace) => workspace.id === domain.organizationId))?.organizationId;
    }
    const subdomain = appSubdomainForHost(host, runtimeConfig.appDomain);
    return {
      workspaces: memberships,
      current: chooseWorkspace(memberships, {
        verifiedCustomDomainOrganizationId: organizationId,
        appSubdomain: subdomain,
        signedOrganizationId: selectedId,
      }),
    };
  });
}

export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  const session = req.session ?? await getRequestSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const { current } = await resolveWorkspaceForRequest(req, session.user.id);

  if (!current) {
    res.status(403).json({ error: "No active workspace membership" });
    return;
  }

  req.tenant = {
    organizationId: current.id,
    userId: session.user.id,
  };
  next();
}