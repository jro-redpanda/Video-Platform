import { Router, type IRouter, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { customDomainsTable } from "@workspace/db";
import { CreateCustomDomainBody, CreateCustomDomainResponse, GetCustomDomainResponse, VerifyCustomDomainResponse } from "@workspace/api-zod";
import { withTenantDb } from "../lib/tenant-db";
import { hasEntitlement } from "../lib/entitlements";
import { requirePermission } from "../lib/permissions";
import { createDomain, DomainConflictError, DomainInputError, publicDomainStatus, removeDomain, requestVerification } from "../lib/custom-domain";
import { enqueueCustomDomainVerification } from "../lib/jobs";

const router: IRouter = Router();
const active = ["pending_verification", "verifying", "verified", "failed", "suspended", "reconciliation_required"] as const;
async function entitled(req: Parameters<typeof hasEntitlement>[0]) { return hasEntitlement(req, "branding.custom_domain"); }
async function current(req: Request) {
  return withTenantDb(req.tenant, async (tx) => (await tx.select().from(customDomainsTable).where(and(eq(customDomainsTable.organizationId, req.tenant.organizationId), inArray(customDomainsTable.lifecycleState, active))).limit(1))[0]);
}

router.get("/custom-domain", requirePermission("workspace.manage"), async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(GetCustomDomainResponse.parse(publicDomainStatus(
    await current(req),
    { includeChallenge: await entitled(req) },
  )));
});
router.post("/custom-domain", requirePermission("workspace.manage"), async (req, res): Promise<void> => {
  if (!await entitled(req)) { res.status(403).json({ error: "This workspace plan does not include branding.custom_domain" }); return; }
  const parsed = CreateCustomDomainBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "hostname is required." }); return; }
  try {
    const row = await withTenantDb(req.tenant, (tx) => createDomain(tx, req.tenant.organizationId, req.tenant.userId, parsed.data.hostname, String(req.id)));
    res.setHeader("Cache-Control", "private, no-store");
    res.status(202).json(CreateCustomDomainResponse.parse(publicDomainStatus(row, { includeChallenge: true })));
  } catch (error) {
    if (error instanceof DomainInputError) { res.status(400).json({ error: "Hostname is invalid or not eligible for custom domains." }); return; }
    if (error instanceof DomainConflictError) { res.status(409).json({ error: "Hostname is already claimed." }); return; }
    throw error;
  }
});
router.post("/custom-domain/verify", requirePermission("workspace.manage"), async (req, res): Promise<void> => {
  if (!await entitled(req)) { res.status(403).json({ error: "This workspace plan does not include branding.custom_domain" }); return; }
  const result = await withTenantDb(req.tenant, (tx) => requestVerification(tx, req.tenant.organizationId, req.tenant.userId, String(req.id)));
  if (result.rateLimited) {
    res.set("Retry-After", String(result.retryAfter));
    res.status(429).json({ error: "Verification was requested too recently." });
    return;
  }
  if (!result.row) { res.status(409).json({ error: "No retryable custom domain verification is pending." }); return; }
  void enqueueCustomDomainVerification(result.row.id).catch(() => {
    req.log.warn("Custom-domain queue wake-up failed; durable repair will retry");
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.status(202).json(VerifyCustomDomainResponse.parse(publicDomainStatus(result.row, { includeChallenge: true })));
});
router.delete("/custom-domain", requirePermission("workspace.manage"), async (req, res): Promise<void> => {
  await withTenantDb(req.tenant, (tx) => removeDomain(tx, req.tenant.organizationId, req.tenant.userId, String(req.id)));
  res.sendStatus(204);
});
export default router;