export const requiredApiMigrations = [
  "0000_baseline.sql",
  "0015_thumbnails.sql",
  "0016_thumbnail_integrity.sql",
  "0029_workspace_onboarding.sql",
  "0030_custom_domains.sql",
  "0031_master_storage_operations.sql",
  "0032_master_archive_integrity.sql",
  "0033_g1_identity_integrity.sql",
  "0034_g3_database_hardening.sql",
] as const;

export function missingRequiredApiMigrations(applied: Iterable<string>) {
  const present = new Set(applied);
  return requiredApiMigrations.filter((name) => !present.has(name));
}