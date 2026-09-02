import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getConstructionPlans, getMigrationPlans } from "pg-boss";
import { catalogFingerprint, EXPECTED_CATALOG_HASHES, type CatalogStage } from "./catalog.ts";

const { Client } = pg;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const lockName = "vid:public-schema-migrations:v1";
const pre15Tables = ["accounts", "audit_logs", "embed_generation_outbox", "folders", "group_permissions", "invitations", "memberships", "organization_customization", "organization_entitlement_overrides", "organizations", "permission_groups", "permissions", "plans", "playback_events", "provider_accounts", "provider_tenant_spaces", "sessions", "users", "verifications", "video_analytics_rollups", "video_embeds", "videos", "webhook_events"];
const pre15Columns: Record<string, string[]> = {
  plans:["id","code","name","storage_limit_gb","entitlements","created_at"], organizations:["id","name","slug","status","plan_id","storage_used_bytes","created_at","updated_at"], organization_customization:["organization_id","player_accent","player_control_foreground","player_control_background","logo_initials","logo_object_key","watermark_object_key","poster_treatment","custom_domain","custom_domain_verified","updated_at"],
  users:["id","email","name","email_verified","image","email_verified_at","created_at","updated_at"], sessions:["id","expires_at","token","created_at","updated_at","ip_address","user_agent","user_id"], accounts:["id","issuer","account_id","provider_id","user_id","access_token","refresh_token","id_token","access_token_expires_at","refresh_token_expires_at","scope","password","created_at","updated_at"], verifications:["id","identifier","value","expires_at","created_at","updated_at"],
  permission_groups:["id","organization_id","name","description","created_at","updated_at"], permissions:["key","description"], group_permissions:["group_id","permission_key"], memberships:["id","organization_id","user_id","group_id","status","created_at","updated_at"], invitations:["id","organization_id","email","group_id","token_hash","invited_by_user_id","expires_at","accepted_at","created_at"],
  provider_accounts:["id","provider_key","label","external_account_id","encrypted_credentials","zone_count_cached","max_zones","accepting_new_tenants","created_at"], provider_tenant_spaces:["id","organization_id","provider_account_id","provider_space_id","idempotency_key","encrypted_credentials","metadata","external_call_claim","external_call_claimed_at","reconciliation_required","state","created_at","updated_at"], organization_entitlement_overrides:["organization_id","key","value"], webhook_events:["id","provider_key","receipt_digest","provider_event_id","provider_account_id","provider_tenant_space_id","provider_asset_id","organization_id","owned_video_id","verification_state","processing_state","diagnostic_code","signature_valid","payload","error","verified_at","claimed_at","processed_at","embed_enqueued_at","created_at","updated_at"], embed_generation_outbox:["id","webhook_event_id","video_id","state","dispatch_claim","claimed_at","attempted_at","dispatched_at","completed_at","attempts","diagnostic_code","created_at","updated_at"], audit_logs:["id","organization_id","actor_user_id","action","subject_type","subject_id","subject_label","metadata","created_at"],
  folders:["id","organization_id","parent_id","name","created_at","updated_at"], videos:["id","organization_id","folder_id","title","description","status","visibility","duration_seconds","thumbnail_color","provider_key","provider_video_id","provider_account_id","provider_tenant_space_id","provider_asset_id","upload_idempotency_key","upload_failure_detail","upload_source_bytes","upload_source_file_name","upload_source_content_type","reserved_bytes","quota_released_at","reservation_expires_at","asset_creation_claim","asset_creation_claimed_at","deletion_claim","deletion_claimed_at","reconciliation_required","initialization_retryable","master_storage_key","master_archived_at","tags","created_at","updated_at"], video_embeds:["video_id","embed_path","generation_version","generation_status","generated_metadata","generated_at","created_at","updated_at"], video_analytics_rollups:["id","organization_id","video_id","day","plays","watch_time_seconds","completion_rate"], playback_events:["id","organization_id","video_id","session_id","event_type","position_seconds","metadata","occurred_at"],
};

type Migration = { name: string; bytes: Buffer; checksum: string };
async function migrations(): Promise<Migration[]> {
  const names = (await readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const bytes = await readFile(join(migrationsDir, name));
    return { name, bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
  }));
}
async function assertBaselineManifest(client: pg.Client) {
  const result = await client.query<{ relname: string }>(`select relname from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r' and relname <> 'schema_migrations' order by relname`);
  const actual = result.rows.map((r) => r.relname);
  const allowed = new Set([...pre15Tables, "thumbnail_upload_intents", "object_cleanup_outbox"]);
  if (actual.some((name) => !allowed.has(name)) || pre15Tables.some((name) => !actual.includes(name))) {
    throw new Error(`baseline adoption refused: public table manifest differs (found ${actual.join(", ")})`);
  }
  for (const [table, expected] of Object.entries(pre15Columns)) {
    const columns = await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position", [table]);
    const actualColumns = columns.rows.map((row) => row.column_name);
    const permitted = table === "videos" ? [...expected, "thumbnail_object_key", "thumbnail_content_type", "thumbnail_size_bytes"] : expected;
    if (actualColumns.length !== permitted.length || actualColumns.some((column) => !permitted.includes(column)) || expected.some((column) => !actualColumns.includes(column))) {
      throw new Error(`baseline adoption refused: incompatible column manifest for ${table}`);
    }
  }
  for (const table of ["organization_customization","permission_groups","memberships","invitations","folders","videos","video_analytics_rollups","playback_events","provider_tenant_spaces","organization_entitlement_overrides","audit_logs"]) {
    const policy = await client.query("select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname='tenant_isolation' and 'vid_app'=any(roles)", [table]);
    if (!policy.rowCount) throw new Error(`baseline adoption refused: missing vid_app tenant policy on ${table}`);
  }
  const fingerprint = await catalogFingerprint(client, "pre15");
  if (fingerprint.hash !== EXPECTED_CATALOG_HASHES.pre15) throw new Error(`baseline adoption refused: catalog fingerprint ${fingerprint.hash}`);
}
async function assertStage(client: pg.Client, stage: CatalogStage) {
  const actual = await catalogFingerprint(client, stage);
  if (actual.hash !== EXPECTED_CATALOG_HASHES[stage]) throw new Error(`${stage} catalog fingerprint mismatch: ${actual.hash}`);
}
async function main() {
  const adopt = process.argv.includes("adopt-baseline");
  if (adopt && !process.argv.includes("--confirm")) throw new Error("refusing adoption: pass adopt-baseline --confirm after reviewing the catalog");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [lockName]);
    await client.query("create table if not exists public.schema_migrations (name text primary key, checksum char(64) not null, applied_at timestamptz not null default now())");
    const files = await migrations();
    const recorded = await client.query<{ name: string; checksum: string }>("select name, checksum from public.schema_migrations");
    const ledger = new Map(recorded.rows.map((row) => [row.name, row.checksum.trim()]));
    const known = new Set(files.map((file) => file.name));
    for (const name of ledger.keys()) if (!known.has(name)) throw new Error(`unknown migration ledger row ${name}`);
    for (const file of files) {
      const seen = ledger.get(file.name);
      if (seen && seen !== file.checksum) throw new Error(`checksum mismatch for applied migration ${file.name}`);
    }
    if (adopt && !ledger.has("0000_baseline.sql")) {
      await assertBaselineManifest(client);
      const baseline = files.find((file) => file.name === "0000_baseline.sql");
      if (!baseline) throw new Error("baseline migration is missing");
      await client.query("insert into public.schema_migrations(name, checksum) values($1,$2)", [baseline.name, baseline.checksum]);
      ledger.set(baseline.name, baseline.checksum);
    }
    if (adopt && !ledger.has("0020_pgboss_12_29_0.sql")) {
      await client.query("begin");
      try {
        const version = await client.query<{ version: number }>("select version from vid_jobs.version");
        if (version.rows.length !== 1 || version.rows[0]?.version !== 39) throw new Error("pg-boss adoption refused: vid_jobs must be exactly schema version 39");
        for (const object of ["job","job_common","job_dependency","queue","schedule","subscription","version","bam"]) {
          const found = await client.query("select 1 from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='vid_jobs' and relname=$1", [object]);
          if (!found.rowCount) throw new Error(`pg-boss adoption refused: missing vid_jobs.${object}`);
        }
        const migration = files.find((file) => file.name === "0020_pgboss_12_29_0.sql")!;
        await client.query("grant usage on schema vid_jobs to vid_app; grant select,insert,update,delete on all tables in schema vid_jobs to vid_app; grant usage,select on all sequences in schema vid_jobs to vid_app; grant execute on all functions in schema vid_jobs to vid_app");
        await assertStage(client, "final");
        await client.query("insert into public.schema_migrations(name, checksum) values($1,$2)", [migration.name, migration.checksum]);
        await client.query("commit");
        ledger.set(migration.name, migration.checksum);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    for (const file of files) {
      if (ledger.has(file.name)) continue;
      await client.query("begin");
      try {
        const source = file.bytes.toString("utf8");
        if (source.includes("PG_BOSS_GENERATED_CONSTRUCTION")) {
          const construction = getConstructionPlans("vid_jobs");
          const upgrade = getMigrationPlans("vid_jobs", 0);
          if (createHash("sha256").update(construction).digest("hex") !== "6fad7e7a63dcb10b485264302adf912af39c8c4f8255c5566adf754ffd0525ba" ||
              createHash("sha256").update(upgrade).digest("hex") !== "cb04acf6911ff52414c553887b393dea298ec261ba58cbb5df067ce51afadfa9") {
            throw new Error("installed pg-boss plans do not match frozen 12.29.0 plans");
          }
          await client.query("rollback");
          await client.query(construction.replace(/\n\s*COMMIT;\s*$/, ""));
          await client.query("grant usage on schema vid_jobs to vid_app; grant select,insert,update,delete on all tables in schema vid_jobs to vid_app; grant usage,select on all sequences in schema vid_jobs to vid_app; grant execute on all functions in schema vid_jobs to vid_app");
          await assertStage(client, "final");
          await client.query("insert into public.schema_migrations(name, checksum) values($1,$2)", [file.name, file.checksum]);
          await client.query("commit");
          ledger.set(file.name, file.checksum);
          continue;
        }
        await client.query(source);
        await assertStage(client, file.name === "0000_baseline.sql"
          ? "pre15"
          : file.name === "0015_thumbnails.sql" ? "step15"
          : file.name === "0016_thumbnail_integrity.sql" ? "thumbnailIntegrity"
          : file.name === "0021_billing.sql" ? "billingBase"
          : file.name === "0022_billing_checkout_claim.sql" ? "billingCheckoutBase"
          : file.name === "0023_billing_provider_status.sql" ? "billingProviderBase"
          : file.name === "0024_billing_customer_generation.sql" ? "billing" : "thumbnailIntegrity");
        await client.query("insert into public.schema_migrations(name, checksum) values($1,$2)", [file.name, file.checksum]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    try { await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]); } finally { await client.end(); }
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });