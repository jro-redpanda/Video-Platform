import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  customDomainsTable,
  customDomainVerificationWindowsTable,
  organizationCustomizationTable,
} from "@workspace/db";
import type { TenantTransaction } from "./tenant-db";
import { runtimeConfig } from "./config";
import { auditJob, auditUser, writeAuditEvent } from "./audit";
import type { DomainDnsResolver } from "./domain-dns-resolver";
import { resolveExactTxt } from "./domain-dns-resolver";
import { withWorkerDb } from "./worker-db";

const active = ["pending_verification", "verifying", "verified", "failed", "suspended", "reconciliation_required"] as const;
const retryDelayMs = 60_000, maxAttempts = 8;
const verificationWindowMs = 15 * 60_000, maxVerificationRequests = 5;
export class DomainInputError extends Error {}
export class DomainConflictError extends Error {}

function hasPostgresCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: string }).code === code) return true;
  return "cause" in error && hasPostgresCode((error as { cause?: unknown }).cause, code);
}

export function normalizeHostname(input: string) {
  if (typeof input !== "string" || input.length > 253 || /[\u0000-\u001f\u007f\s]/.test(input)) throw new DomainInputError();
  const raw = input.endsWith(".") ? input.slice(0, -1) : input;
  if (!raw || raw.includes("/") || raw.includes(":") || raw.includes("@") || raw.includes("*") || raw.includes("..")) throw new DomainInputError();
  const hostname = domainToASCII(raw).toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.endsWith(".") || !hostname.includes(".") || isIP(hostname) !== 0
    || /^\d+(?:\.\d+)+$/.test(hostname)
    || hostname.includes(":") || hostname.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new DomainInputError();
  const reserved = /(^|\.)(localhost|local|internal|test|dev|onion|invalid|example|home|lan|localdomain|arpa)$/;
  const documentationDomain = /(^|\.)(example\.(com|net|org))$/;
  const app = domainToASCII(runtimeConfig.appDomain.replace(/\.$/, "")).toLowerCase();
  if (reserved.test(hostname) || documentationDomain.test(hostname)
    || hostname === app || hostname.endsWith(`.${app}`)) throw new DomainInputError();
  return hostname;
}

export function publicDomainStatus(row?: typeof customDomainsTable.$inferSelect) {
  if (!row) return { hostname: null, lifecycleState: null, txtRecordName: null, txtRecordValue: null, lastCheckedAt: null, verifiedAt: null, retryable: false, message: "No custom domain is configured.", activationState: "not_ready" as const };
  const message = row.lifecycleState === "verified" ? "DNS ownership verified. External TLS and edge activation is still required."
    : row.lifecycleState === "reconciliation_required" ? "Verification requires operator reconciliation."
      : row.lifecycleState === "failed" ? "DNS verification did not find the required TXT record."
        : row.lifecycleState === "suspended" ? "Verification is temporarily suspended." : "Publish the TXT record, then request verification.";
  return { hostname: row.hostname, lifecycleState: row.lifecycleState, txtRecordName: row.challengeName, txtRecordValue: row.challengeValue,
    lastCheckedAt: row.lastCheckedAt, verifiedAt: row.verifiedAt, retryable: row.retryable, message,
    activationState: row.lifecycleState === "verified" ? "external_setup_required" as const : "not_ready" as const };
}

export async function createDomain(tx: TenantTransaction, organizationId: string, userId: string, hostnameInput: string, requestId?: string) {
  const hostname = normalizeHostname(hostnameInput);
  const [existing] = await tx.select().from(customDomainsTable).where(and(eq(customDomainsTable.organizationId, organizationId), inArray(customDomainsTable.lifecycleState, active))).limit(1);
  if (existing?.hostname === hostname && existing.lifecycleState !== "removed") return existing;
  const challengeValue = `video-domain-verify=${randomBytes(24).toString("base64url")}`;
  try {
    if (existing) await tx.update(customDomainsTable).set({ lifecycleState: "removed", removedAt: new Date(), retryable: false, claimToken: null }).where(eq(customDomainsTable.id, existing.id));
    const [created] = await tx.insert(customDomainsTable).values({ organizationId, hostname, challengeName: `_video-verify.${hostname}`, challengeValue }).returning();
    await tx.update(organizationCustomizationTable).set({ customDomain: hostname, customDomainVerified: false }).where(eq(organizationCustomizationTable.organizationId, organizationId));
    await writeAuditEvent(tx, { organizationId, actor: auditUser(userId), action: existing ? "custom_domain.replaced" : "custom_domain.requested", category: "workspace", subject: { type: "custom_domain", id: created!.id, label: hostname }, afterState: { hostname, state: "pending_verification" }, requestId });
    return created!;
  } catch (error: unknown) {
    if (hasPostgresCode(error, "23505")) throw new DomainConflictError();
    throw error;
  }
}

export async function requestVerification(tx: TenantTransaction, organizationId: string, userId: string, requestId?: string) {
  const rateResult = await tx.execute(sql`
    insert into ${customDomainVerificationWindowsTable}
      (organization_id, window_started_at, attempts, updated_at)
    values (${organizationId}, now(), 1, now())
    on conflict (organization_id) do update set
      attempts = case
        when ${customDomainVerificationWindowsTable.windowStartedAt} < now() - interval '15 minutes' then 1
        else ${customDomainVerificationWindowsTable.attempts} + 1
      end,
      window_started_at = case
        when ${customDomainVerificationWindowsTable.windowStartedAt} < now() - interval '15 minutes' then now()
        else ${customDomainVerificationWindowsTable.windowStartedAt}
      end,
      updated_at = now()
    returning attempts,
      greatest(1, ceil(extract(epoch from (
        window_started_at + interval '15 minutes' - now()
      ))))::int as retry_after
  `);
  const rate = rateResult.rows[0] as { attempts: number; retry_after: number } | undefined;
  if (!rate || rate.attempts > maxVerificationRequests) {
    return { rateLimited: true as const, retryAfter: rate?.retry_after ?? Math.ceil(verificationWindowMs / 1000) };
  }
  const [row] = await tx.select().from(customDomainsTable).where(and(eq(customDomainsTable.organizationId, organizationId), inArray(customDomainsTable.lifecycleState, active))).limit(1);
  if (!row || !row.retryable) return { rateLimited: false as const, row: undefined };
  const now = new Date();
  if (row.verifyRequestedAt && now.getTime() - row.verifyRequestedAt.getTime() < retryDelayMs) {
    return {
      rateLimited: true as const,
      retryAfter: Math.ceil((retryDelayMs - (now.getTime() - row.verifyRequestedAt.getTime())) / 1000),
    };
  }
  const [updated] = await tx.update(customDomainsTable).set({ verifyRequestedAt: now, retryAfterAt: now, lifecycleState: "pending_verification" }).where(eq(customDomainsTable.id, row.id)).returning();
  if (!row.verifyRequestedAt) await writeAuditEvent(tx, { organizationId, actor: auditUser(userId), action: "custom_domain.verification_requested", category: "workspace", subject: { type: "custom_domain", id: row.id, label: row.hostname }, afterState: { state: "pending_verification" }, requestId });
  return { rateLimited: false as const, row: updated! };
}

export async function removeDomain(tx: TenantTransaction, organizationId: string, userId: string, requestId?: string) {
  const [row] = await tx.select().from(customDomainsTable).where(and(eq(customDomainsTable.organizationId, organizationId), inArray(customDomainsTable.lifecycleState, active))).limit(1);
  if (!row) return;
  await tx.update(organizationCustomizationTable).set({ customDomain: null, customDomainVerified: false }).where(eq(organizationCustomizationTable.organizationId, organizationId));
  await tx.update(customDomainsTable).set({ lifecycleState: "removed", removedAt: new Date(), retryable: false, claimToken: null, challengeValue: "revoked" }).where(eq(customDomainsTable.id, row.id));
  await writeAuditEvent(tx, { organizationId, actor: auditUser(userId), action: "custom_domain.removed", category: "workspace", subject: { type: "custom_domain", id: row.id, label: row.hostname }, afterState: { state: "removed" }, requestId });
}

export async function processCustomDomainVerification(
  domainId: string,
  resolver: DomainDnsResolver,
  auditWriter: typeof writeAuditEvent = writeAuditEvent,
  dispatchClaim?: string,
) {
  const claim = randomUUID();
  const row = await withWorkerDb("custom_domain", async (tx) => {
    const ownsDispatch = dispatchClaim
      ? and(
        eq(customDomainsTable.lifecycleState, "verifying"),
        eq(customDomainsTable.claimToken, dispatchClaim),
      )
      : inArray(customDomainsTable.lifecycleState, ["pending_verification", "failed"]);
    const [claimed] = await tx.update(customDomainsTable).set({ lifecycleState: "verifying", claimToken: claim, claimedAt: new Date() })
      .where(and(eq(customDomainsTable.id, domainId), ownsDispatch)).returning();
    return claimed;
  });
  if (!row) return { skipped: true };

  let matched = false, diagnostic = "dns_lookup_failed";
  try { matched = await resolveExactTxt(resolver, row.challengeName, row.challengeValue); diagnostic = matched ? "" : "txt_not_found"; } catch (error) { diagnostic = error instanceof Error && error.message === "dns_timeout" ? "dns_timeout" : "dns_lookup_failed"; }

  return withWorkerDb("custom_domain", async (tx) => {
    const attempts = row.attempts + 1, retryable = !matched && attempts < maxAttempts;
    const state = matched ? "verified" : retryable ? "failed" : "suspended";
    const [changed] = await tx.update(customDomainsTable).set({ lifecycleState: state, attempts, retryable, lastCheckedAt: new Date(), verifiedAt: matched ? new Date() : null, retryAfterAt: retryable ? new Date(Date.now() + retryDelayMs * attempts) : null, claimToken: null, claimedAt: null, diagnosticCode: diagnostic || null })
      .where(and(eq(customDomainsTable.id, row.id), eq(customDomainsTable.lifecycleState, "verifying"), eq(customDomainsTable.claimToken, claim))).returning();
    if (!changed) return { skipped: true };
    if (matched) await tx.update(organizationCustomizationTable).set({ customDomain: row.hostname, customDomainVerified: true }).where(eq(organizationCustomizationTable.organizationId, row.organizationId));
    if (matched || state === "suspended" || row.attempts === 0) {
      await auditWriter(tx, { organizationId: row.organizationId, actor: auditJob(), action: matched ? "custom_domain.verified" : state === "suspended" ? "custom_domain.suspended" : "custom_domain.verification_failed", category: "workspace", subject: { type: "custom_domain", id: row.id, label: row.hostname }, beforeState: { state: "verifying" }, afterState: { state, retryable }, metadata: diagnostic ? { code: diagnostic } : {} });
    }
    return { verified: matched };
  });
}