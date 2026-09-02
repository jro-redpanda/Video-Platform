import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  organizationEntitlementOverridesTable,
  organizationBillingTable,
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
export type BillingAccess = { status: string; canCreate: boolean; graceEndsAt: Date | null };

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

export async function resolveBillingAccess(tx: TenantTransaction, organizationId: string): Promise<BillingAccess> {
  const [billing] = await tx.select({
    status: organizationBillingTable.status,
    graceEndsAt: organizationBillingTable.graceEndsAt,
  }).from(organizationBillingTable)
    .where(eq(organizationBillingTable.organizationId, organizationId)).limit(1);
  if (!billing || billing.status === "unmanaged") return { status: "unmanaged", canCreate: true, graceEndsAt: null };
  const canCreate = billing.status === "active" || billing.status === "trialing" ||
    (billing.status === "past_due" && Boolean(billing.graceEndsAt && billing.graceEndsAt > new Date()));
  return { status: billing.status, canCreate, graceEndsAt: billing.graceEndsAt };
}

export async function requireBillingCreateAccess(tx: TenantTransaction, organizationId: string) {
  const access = await resolveBillingAccess(tx, organizationId);
  if (!access.canCreate) throw new BillingRestrictedError(access.status);
}

export class BillingRestrictedError extends Error {
  constructor(readonly billingStatus: string) {
    super("Billing access is restricted");
  }
}

export async function requireCreateAccess(req: Request, res: Response, next: NextFunction) {
  const access = await withTenantDb(req.tenant, (tx) => resolveBillingAccess(tx, req.tenant.organizationId));
  if (!access.canCreate) {
    res.status(403).json({ error: "Billing access is restricted", code: "billing_create_restricted", billingStatus: access.status });
    return;
  }
  next();
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