import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { groupPermissionsTable, membershipsTable } from "@workspace/db";
import { withTenantDb } from "./tenant-db";

export type Permission =
  | "workspace.manage"
  | "videos.read"
  | "videos.create"
  | "videos.update"
  | "videos.delete"
  | "members.manage"
  | "analytics.read";

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const allowed = await withTenantDb(req.tenant, async (tx) => {
      const [match] = await tx.select({ key: groupPermissionsTable.permissionKey })
        .from(membershipsTable)
        .innerJoin(groupPermissionsTable, eq(groupPermissionsTable.groupId, membershipsTable.groupId))
        .where(and(
          eq(membershipsTable.organizationId, req.tenant.organizationId),
          eq(membershipsTable.userId, req.tenant.userId),
          eq(membershipsTable.status, "active"),
          eq(groupPermissionsTable.permissionKey, permission),
        ))
        .limit(1);
      return Boolean(match);
    });

    if (!allowed) {
      req.log.warn({ permission }, "Permission denied");
      res.status(403).json({ error: "Permission denied" });
      return;
    }
    next();
  };
}