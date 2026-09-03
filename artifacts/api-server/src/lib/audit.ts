import { analyticsRateWindowsTable, auditLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import type { TenantTransaction } from "./tenant-db";

const machine = /^[a-z][a-z0-9_.-]{0,99}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secretKey = /(secret|token|pass(word)?|cookie|authorization|credential|signed.?url|webhook.?payload|api.?key)/i;
const maxDepth = 8, maxArray = 100, maxString = 4_000;
export const AUDIT_JSON_MAX_BYTES = 32_000;

export type AuditActorKind = "user" | "system" | "webhook" | "job";
export type AuditActor = { kind: AuditActorKind; userId?: string | null };
export type AuditInput = {
  organizationId: string; action: string; category: string; actor: AuditActor;
  subject: { type: string; id?: string | null; label: string };
  beforeState?: unknown; afterState?: unknown; metadata?: unknown; requestId?: string | null;
};

/** Removes credentials and constrains arbitrary structured context before persistence. */
function jsonBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function boundedString(input: string, limit: number) {
  let output = "";
  for (const character of input.slice(0, maxString)) {
    if (jsonBytes(output + character) > limit) break;
    output += character;
  }
  return output;
}
function sanitizeValue(value: unknown, limit: number): unknown {
  const marker = "[truncated]";
  const visit = (input: unknown, depth: number, available: number): unknown => {
    if (available < 4) return null;
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : "[invalid-number]";
    if (typeof input === "string") return boundedString(input, available);
    if (depth >= maxDepth) return "[max-depth]";
    if (Array.isArray(input)) {
      const out: unknown[] = [];
      for (const item of input.slice(0, maxArray)) {
        const child = visit(item, depth + 1, available);
        if (jsonBytes([...out, child]) > available) {
          if (jsonBytes([...out, marker]) <= available) out.push(marker);
          break;
        }
        out.push(child);
      }
      return out;
    }
    if (typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, 100)) {
        const safeKey = boundedString(key, 130).slice(0, 128);
        const child = secretKey.test(key) ? "[redacted]" : visit(item, depth + 1, available);
        const candidate = { ...out, [safeKey]: child };
        if (jsonBytes(candidate) > available) {
          if (jsonBytes({ ...out, __truncated: marker }) <= available) out.__truncated = marker;
          break;
        }
        out[safeKey] = child;
      }
      return out;
    }
    return `[${typeof input}]`;
  };
  const output = visit(value, 0, limit);
  return jsonBytes(output) <= limit ? output : marker;
}
export function sanitizeAuditValue(value: unknown): Record<string, unknown> {
  const output = sanitizeValue(value, AUDIT_JSON_MAX_BYTES);
  const wrapped = output && !Array.isArray(output) && typeof output === "object" ? output as Record<string, unknown> : { value: output };
  return jsonBytes(wrapped) <= AUDIT_JSON_MAX_BYTES ? wrapped : { value: "[truncated]" };
}
function sanitizeAuditPayload(beforeState: unknown, afterState: unknown, metadata: unknown) {
  const output = sanitizeValue({ beforeState, afterState, metadata }, AUDIT_JSON_MAX_BYTES) as Record<string, unknown>;
  const normalized = {
    beforeState: output.beforeState == null ? null : sanitizeAuditValue(output.beforeState),
    afterState: output.afterState == null ? null : sanitizeAuditValue(output.afterState),
    metadata: output.metadata == null ? {} : sanitizeAuditValue(output.metadata),
  };
  if (jsonBytes(normalized) <= AUDIT_JSON_MAX_BYTES) return normalized;
  return { beforeState: null, afterState: null, metadata: { value: "[truncated]" } };
}

export function auditDiff(before: unknown, after: unknown) {
  return { beforeState: sanitizeAuditValue(before), afterState: sanitizeAuditValue(after) };
}
export const auditUser = (userId: string): AuditActor => ({ kind: "user", userId });
export const auditSystem = (): AuditActor => ({ kind: "system" });
export const auditJob = (): AuditActor => ({ kind: "job" });
export const auditWebhook = (): AuditActor => ({ kind: "webhook" });

export class AuditExportRateLimitError extends Error {
  constructor(public readonly retryAfter: number) { super("audit_export_rate_limited"); }
}

/** Atomic persistent 5/15 minute tenant+actor export window; no IPs are retained. */
export async function consumeAuditExportLimit(tx: TenantTransaction, organizationId: string, actorId: string, now = new Date()) {
  const windowMs = 15 * 60_000;
  const started = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expires = new Date(started.getTime() + windowMs);
  const dimensionHash = createHmac("sha256", process.env.SESSION_SECRET ?? "")
    .update(`audit_export:${actorId}`).digest("hex");
  const [row] = await tx.insert(analyticsRateWindowsTable).values({
    organizationId, dimensionType: "audit_export", dimensionHash, windowStartedAt: started, expiresAt: expires,
    requestCount: 1, eventCount: 0,
  }).onConflictDoUpdate({
    target: [analyticsRateWindowsTable.organizationId, analyticsRateWindowsTable.dimensionType, analyticsRateWindowsTable.dimensionHash, analyticsRateWindowsTable.windowStartedAt],
    set: { requestCount: sql`${analyticsRateWindowsTable.requestCount} + 1` },
  }).returning({ requests: analyticsRateWindowsTable.requestCount });
  if (!row || row.requests > 5) throw new AuditExportRateLimitError(Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000)));
}

export async function writeAuditEvent(tx: TenantTransaction, input: AuditInput) {
  if (!uuid.test(input.organizationId) || !machine.test(input.action) || !machine.test(input.category)
    || !machine.test(input.subject.type) || !input.subject.label?.trim() || input.subject.label.length > 500
    || (input.subject.id != null && (!input.subject.id.trim() || input.subject.id.length > 200))
    || (input.actor.kind === "user" && (!input.actor.userId || !uuid.test(input.actor.userId)))
    || (input.actor.kind !== "user" && input.actor.userId))
    throw new Error("Invalid audit event");
  const safe = sanitizeAuditPayload(input.beforeState, input.afterState, input.metadata ?? {});
  const [event] = await tx.insert(auditLogsTable).values({
    organizationId: input.organizationId, action: input.action, category: input.category,
    actorKind: input.actor.kind, actorUserId: input.actor.userId ?? null,
    subjectType: input.subject.type, subjectId: input.subject.id ?? null, subjectLabel: input.subject.label.trim(),
    beforeState: input.beforeState === undefined ? null : safe.beforeState,
    afterState: input.afterState === undefined ? null : safe.afterState,
    metadata: safe.metadata,
    requestId: input.requestId?.slice(0, 200) ?? null,
  }).returning();
  return event;
}