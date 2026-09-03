import { createHmac, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";

export type WorkspaceSelection = { organizationId: string; userId: string; expiresAt: number };
export type WorkspaceCandidate = { id: string; slug: string };
const cookieName = "vid_workspace";

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required for workspace selection");
  return value;
}
function signature(payload: string) { return createHmac("sha256", secret()).update(payload).digest("base64url"); }

export function encodeWorkspaceSelection(selection: WorkspaceSelection): string {
  const payload = Buffer.from(JSON.stringify(selection)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function decodeWorkspaceSelection(value: string | undefined, userId: string, now = Date.now()): string | undefined {
  if (!value) return;
  const [payload, supplied, ...extra] = value.split(".");
  if (!payload || !supplied || extra.length) return;
  const expected = signature(payload);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return;
  try {
    const selection = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WorkspaceSelection;
    if (selection.userId !== userId || !Number.isSafeInteger(selection.expiresAt) || selection.expiresAt <= now
      || typeof selection.organizationId !== "string") return;
    return selection.organizationId;
  } catch { return; }
}
export function selectionCookie(selection: WorkspaceSelection) {
  return { name: cookieName, value: encodeWorkspaceSelection(selection), options: {
    httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production",
    maxAge: Math.max(0, selection.expiresAt - Date.now()), path: "/api",
  } };
}
export { cookieName };

/** Returns a DNS hostname only; ports, IPs, malformed values and multi-label
 * tricks are deliberately rejected before tenant lookup. */
export function normalizeRequestHost(host: string | undefined): string | undefined {
  if (!host || host.length > 255 || /[\s/@\\\u0000-\u001f]/.test(host)) return;
  const value = host.startsWith("[") ? "" : host.replace(/:\d+$/, "").replace(/\.$/, "");
  const normalized = domainToASCII(value).toLowerCase();
  if (!normalized || normalized.length > 253 || normalized.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return;
  return normalized;
}

/** Only `<slug>.<app-domain>` is an application workspace hostname. */
export function appSubdomainForHost(host: string | undefined, appDomain: string): string | undefined {
  const normalized = normalizeRequestHost(host);
  const app = normalizeRequestHost(appDomain);
  if (!normalized || !app || !normalized.endsWith(`.${app}`)) return;
  const label = normalized.slice(0, -(app.length + 1));
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : undefined;
}

export function chooseWorkspace<T extends WorkspaceCandidate>(
  workspaces: T[],
  selectors: {
    verifiedCustomDomainOrganizationId?: string;
    appSubdomain?: string;
    signedOrganizationId?: string;
  },
): T | undefined {
  return workspaces.find((workspace) => workspace.id === selectors.verifiedCustomDomainOrganizationId)
    ?? workspaces.find((workspace) => workspace.slug === selectors.appSubdomain)
    ?? workspaces.find((workspace) => workspace.id === selectors.signedOrganizationId)
    ?? workspaces[0];
}