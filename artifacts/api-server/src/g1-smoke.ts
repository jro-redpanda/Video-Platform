import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appSubdomainForHost,
  chooseWorkspace,
  decodeWorkspaceSelection,
  encodeWorkspaceSelection,
  normalizeRequestHost,
} from "./lib/workspace-selection";
import { permissionCatalog, systemGroups } from "./lib/permission-catalog";
import { validatedEntitlementValue } from "./lib/entitlements";
import {
  acceptInvitation,
  hashInvitationToken,
  InvitationConflictError,
  InvitationUnavailableError,
  issueInvitation,
} from "./lib/invitations";
import { auth } from "./lib/auth";
import { runtimeConfig } from "./lib/config";

// Local-only regression seams: no database, provider, or network access.
process.env.SESSION_SECRET ??= "g1-local-smoke-secret";
const now = Date.now();
const token = encodeWorkspaceSelection({ organizationId: "org-a", userId: "user-a", expiresAt: now + 10_000 });
assert.equal(decodeWorkspaceSelection(token, "user-a", now), "org-a");
assert.equal(decodeWorkspaceSelection(`${token}x`, "user-a", now), undefined, "tampered selectors must fail");
assert.equal(decodeWorkspaceSelection(token, "user-b", now), undefined, "selectors are user-bound");
assert.equal(decodeWorkspaceSelection(encodeWorkspaceSelection({ organizationId: "org-a", userId: "user-a", expiresAt: now - 1 }), "user-a", now), undefined, "expired selectors must fail");
assert.equal(normalizeRequestHost("TEAM.example.com:443"), "team.example.com");
assert.equal(normalizeRequestHost("team.example.com/path"), undefined);
assert.equal(appSubdomainForHost("team.app.example.com", "app.example.com"), "team");
assert.equal(appSubdomainForHost("a.b.app.example.com", "app.example.com"), undefined, "only one label is an app subdomain");
const candidates = [{ id: "org-a", slug: "alpha" }, { id: "org-b", slug: "beta" }];
assert.equal(chooseWorkspace(candidates, {
  verifiedCustomDomainOrganizationId: "org-b",
  appSubdomain: "alpha",
  signedOrganizationId: "org-a",
})?.id, "org-b", "verified custom domains have priority");
assert.equal(chooseWorkspace(candidates, {
  verifiedCustomDomainOrganizationId: "foreign-org",
  appSubdomain: "beta",
  signedOrganizationId: "org-a",
})?.id, "org-b", "foreign custom-domain ids are ignored");
assert.equal(chooseWorkspace(candidates, {
  appSubdomain: "foreign",
  signedOrganizationId: "org-b",
})?.id, "org-b", "foreign subdomains are ignored");
assert.equal(chooseWorkspace(candidates, {})?.id, "org-a", "fallback is deterministic");
assert.equal(permissionCatalog.some(([key]) => key === "members.manage"), true);
assert.deepEqual(systemGroups.map((group) => group.systemKey), ["owners", "editors", "viewers"]);
assert.equal(validatedEntitlementValue("limits.max_users", 3), 3);
for (const malformed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", true]) {
  assert.equal(validatedEntitlementValue("limits.max_users", malformed), undefined);
}
assert.equal(validatedEntitlementValue("feature.custom_groups", true), true);
assert.equal(validatedEntitlementValue("feature.custom_groups", "true"), undefined);
const digest = hashInvitationToken("A".repeat(43));
assert.equal(digest.length, 64);
assert.equal(digest.includes("A".repeat(20)), false, "stored invitation material must not contain the raw token");
await assert.rejects(
  issueInvitation(
    { organizationId: "00000000-0000-0000-0000-000000000001", userId: "00000000-0000-0000-0000-000000000002" },
    { email: "invitee@example.com", groupId: "00000000-0000-0000-0000-000000000003" },
  ),
  InvitationUnavailableError,
  "an unconfigured delivery adapter must fail before database access",
);
await assert.rejects(
  acceptInvitation(
    { id: "00000000-0000-0000-0000-000000000002", email: "invitee@example.com" },
    "not-a-token",
  ),
  InvitationConflictError,
  "malformed invitation tokens must fail before database access",
);
const signUpResponse = await auth.handler(new Request(`https://${runtimeConfig.appDomain}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Uninvited User",
    email: "uninvited@example.com",
    password: "not-a-real-password",
  }),
}));
assert.equal(signUpResponse.ok, false, "public email/password signup must be disabled server-side");
assert.match(await signUpResponse.text(), /valid invitation is required/i);

const protectedMutations = {
  "billing.ts": [
    ["post", "/billing/checkout", "workspace.manage"],
    ["post", "/billing/change-plan", "workspace.manage"],
    ["post", "/billing/cancel", "workspace.manage"],
    ["post", "/billing/resume", "workspace.manage"],
    ["post", "/billing/portal", "workspace.manage"],
    ["post", "/billing/reconcile", "workspace.manage"],
  ],
  "custom-domain.ts": [
    ["post", "/custom-domain", "workspace.manage"],
    ["post", "/custom-domain/verify", "workspace.manage"],
    ["delete", "/custom-domain", "workspace.manage"],
  ],
  "folders.ts": [
    ["post", "/folders", "videos.update"],
    ["patch", "/folders/:folderId", "videos.update"],
    ["delete", "/folders/:folderId", "videos.update"],
  ],
  "master-storage.ts": [
    ["post", "/videos/:videoId/master-archive", "videos.update"],
    ["post", "/videos/:videoId/master-restore", "videos.update"],
  ],
  "members.ts": [
    ["post", "/permission-groups", "members.manage"],
    ["patch", "/permission-groups/:groupId", "members.manage"],
    ["delete", "/permission-groups/:groupId", "members.manage"],
    ["patch", "/members/:membershipId", "members.manage"],
    ["post", "/invitations", "members.manage"],
    ["delete", "/invitations/:invitationId", "members.manage"],
    ["post", "/invitations/:invitationId/reissue", "members.manage"],
  ],
  "platform.ts": [
    ["patch", "/workspace", "workspace.manage"],
    ["post", "/videos/upload-init", "videos.create"],
    ["post", "/videos/:videoId/upload-complete", "videos.create"],
    ["post", "/videos/:videoId/upload-cancel", "videos.create"],
    ["patch", "/videos/bulk", "videos.update"],
    ["patch", "/videos/:videoId", "videos.update"],
    ["post", "/videos/bulk-delete", "videos.delete"],
    ["delete", "/videos/:videoId", "videos.delete"],
  ],
  "thumbnails.ts": [
    ["post", "/videos/:videoId/thumbnail-upload-intent", "videos.update"],
    ["post", "/videos/:videoId/thumbnail-finalize", "videos.update"],
    ["delete", "/videos/:videoId/thumbnail", "videos.update"],
  ],
} as const;
for (const [file, mutations] of Object.entries(protectedMutations)) {
  const source = readFileSync(`src/routes/${file}`, "utf8");
  for (const [method, route, permission] of mutations) {
    const declaration = new RegExp(
      `router\\.${method}\\(\\s*["']${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*,\\s*requirePermission\\(["']${permission.replace(".", "\\.")}["']\\)`,
    );
    assert.match(source, declaration, `${method.toUpperCase()} ${route} must require ${permission}`);
  }
}
console.log("G1 local smoke passed");