import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  organizationEntitlementOverridesTable,
  organizationsTable,
  plansTable,
} from "@workspace/db";
import { withTenantDb, type TenantTransaction } from "./tenant-db";

export const entitlementKeys = [
  "branding.logo",
  "branding.player_colors",
  "branding.watermark",
  "branding.custom_domain",
  "limits.max_users",
  "limits.max_storage_gb",
  "limits.max_videos",
  "limits.monthly_bandwidth_gb",
  "feature.custom_groups",
  "feature.api_access",
  "feature.captions",
  "feature.analytics_export",
] as const;

export type EntitlementKey = (typeof entitlementKeys)[number];
export type EntitlementValue = boolean | number | string;
export type ResolvedEntitlements = Record<EntitlementKey, EntitlementValue>;

const defaults: ResolvedEntitlements = {
  "branding.logo": false,
  "branding.player_colors": false,
  "branding.watermark": false,
  "branding.custom_domain": false,
  "limits.max_users": 0,
  "limits.max_storage_gb": 0,
  "limits.max_videos": 0,
  "limits.monthly_bandwidth_gb": 0,
  "feature.custom_groups": false,
  "feature.api_access": false,
  "feature.captions": false,
  "feature.analytics_export": false,
};

export async function resolveEntitlements(tx: TenantTransaction, organizationId: string): Promise<ResolvedEntitlements> {
  const [organization] = await tx.select({ entitlements: plansTable.entitlements })
    .from(organizationsTable)
    .innerJoin(plansTable, eq(plansTable.id, organizationsTable.planId))
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  const overrides = await tx.select({
    key: organizationEntitlementOverridesTable.key,
    value: organizationEntitlementOverridesTable.value,
  }).from(organizationEntitlementOverridesTable)
    .where(eq(organizationEntitlementOverridesTable.organizationId, organizationId));

  const resolved = { ...defaults };
  for (const key of entitlementKeys) {
    const value = organization?.entitlements[key];
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") resolved[key] = value;
  }
  for (const override of overrides) {
    if (entitlementKeys.includes(override.key as EntitlementKey)) {
      resolved[override.key as EntitlementKey] = override.value;
    }
  }
  return resolved;
}

function isEnabled(value: EntitlementValue): boolean {
  return value === true || (typeof value === "number" && value > 0);
}

export async function hasEntitlement(req: Request, key: EntitlementKey) {
  return withTenantDb(req.tenant, async (tx) => isEnabled((await resolveEntitlements(tx, req.tenant.organizationId))[key]));
}

/** Tenant scope always comes from resolveTenant; clients cannot supply an organization ID. */
export function requireEntitlement(key: EntitlementKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!await hasEntitlement(req, key)) {
      req.log.warn({ entitlement: key }, "Entitlement denied");
      res.status(403).json({ error: `This workspace plan does not include ${key}` });
      return;
    }
    next();
  };
}