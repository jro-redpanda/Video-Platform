export const permissionCatalog = [
  ["workspace.manage", "Manage workspace settings and branding"],
  ["videos.read", "View the video library"],
  ["videos.create", "Create videos and upload media"],
  ["videos.update", "Edit video metadata and visibility"],
  ["videos.delete", "Delete videos and provider media"],
  ["members.manage", "Invite, suspend, and assign members"],
  ["analytics.read", "View workspace analytics"],
  ["audit.read", "View the immutable audit trail"],
  ["audit.export", "Export the immutable audit trail"],
] as const;

export type Permission = (typeof permissionCatalog)[number][0];

export const systemGroups = [
  { systemKey: "owners", name: "Owners", description: "Full workspace access", permissions: permissionCatalog.map(([key]) => key) },
  { systemKey: "editors", name: "Editors", description: "Create and manage videos", permissions: ["videos.read", "videos.create", "videos.update", "videos.delete", "analytics.read"] },
  { systemKey: "viewers", name: "Viewers", description: "View videos and analytics", permissions: ["videos.read", "analytics.read"] },
] as const;