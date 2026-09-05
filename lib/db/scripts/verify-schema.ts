import pg from "pg";
import { catalogFingerprint, EXPECTED_CATALOG_HASHES } from "./catalog.ts";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_TABLE_PRIVILEGES,
  TENANT_RLS_TABLES,
  WORKER_COLUMN_PRIVILEGES,
  WORKER_TABLE_PRIVILEGES,
} from "./security-manifest.ts";
import { formatOperationalError } from "./safe-error.ts";
const { Client } = pg;
const tables = ["plans","organizations","organization_customization","users","sessions","accounts","verifications","permission_groups","permissions","group_permissions","memberships","invitations","provider_accounts","provider_tenant_spaces","organization_entitlement_overrides","webhook_events","embed_generation_outbox","audit_logs","folders","videos","video_embeds","video_analytics_rollups","playback_events","thumbnail_upload_intents","object_cleanup_outbox","organization_billing","billing_operations","billing_event_receipts","analytics_dirty_days","analytics_rate_windows","analytics_playback_sessions","onboarding_provisioning_intents","custom_domains","custom_domain_verification_windows","master_storage_operations","video_library_snapshots","video_library_snapshot_items"];
const columns = ["videos.thumbnail_object_key","videos.thumbnail_content_type","videos.thumbnail_size_bytes","videos.master_sha256","videos.master_size_bytes","videos.master_content_type","object_cleanup_outbox.quarantined_at","playback_events.event_id","playback_events.embed_id","playback_events.received_at","video_analytics_rollups.unique_sessions","video_analytics_rollups.completions","audit_logs.actor_kind","audit_logs.category","audit_logs.before_state","audit_logs.after_state","audit_logs.request_id","onboarding_provisioning_intents.requested_by_user_id","onboarding_provisioning_intents.dispatch_claim","custom_domains.hostname","custom_domains.challenge_value","custom_domains.lifecycle_state","master_storage_operations.operation","master_storage_operations.restore_storage_key","master_storage_operations.restore_sha256","master_storage_operations.restore_size_bytes","master_storage_operations.restore_content_type","master_storage_operations.idempotency_key","master_storage_operations.dispatch_generation","permission_groups.system_key","invitations.revoked_at","invitations.delivered_at","invitations.accepted_by_user_id"];
const indexes = ["videos_org_created_idx","videos_thumbnail_metadata_check","thumbnail_upload_intents_object_key_idx","thumbnail_upload_intents_video_idx","thumbnail_upload_intents_expiry_idx","object_cleanup_outbox_object_key_idx","object_cleanup_outbox_pending_idx","playback_events_org_event_idx","video_rollups_org_video_day_idx","analytics_dirty_days_available_idx","analytics_rate_windows_expiry_idx","audit_logs_org_time_idx","audit_logs_org_category_time_idx","audit_logs_org_subject_time_idx","audit_logs_org_actor_time_idx","onboarding_intents_org_idx","onboarding_intents_dispatch_idx","onboarding_intents_user_idx","custom_domains_one_active_org_idx","custom_domains_unique_active_hostname_idx","custom_domains_worker_idx","video_library_snapshots_id_org_idx","video_library_snapshots_org_expiry_idx","video_library_snapshot_items_org_snapshot_idx","videos_id_organization_identity_idx","master_storage_operations_video_organization_fk","master_storage_operations_idempotency_idx","master_storage_operations_one_outstanding_video_idx","master_storage_operations_dispatch_idx","master_storage_operations_idempotency_key_check","master_storage_operations_claim_state_check","master_storage_operations_retry_state_check","master_storage_operations_completed_state_check","master_storage_operations_retry_after_check","permission_groups_org_system_key_idx","memberships_org_group_fk","invitations_org_group_fk","invitations_pending_org_email_idx"];
type TableGrant = { table_name: string; grantee: string; privilege_type: string };
const expectedTableGrants = (manifest: Record<string, readonly string[]>, grantee: string) =>
  Object.entries(manifest).flatMap(([table_name, privileges]) =>
    privileges.map((privilege_type) => ({ table_name, grantee, privilege_type })));
const grantKey = (grant: TableGrant) => `${grant.table_name}:${grant.grantee}:${grant.privilege_type}`;
const sortedGrantKeys = (grants: TableGrant[]) => grants.map(grantKey).sort();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  try {
    const relation = await client.query<{ relname: string }>("select relname from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r'");
    const present = new Set(relation.rows.map((r) => r.relname));
    for (const table of tables) if (!present.has(table)) throw new Error(`missing required table public.${table}`);
    const expectedTables = [...tables, "schema_migrations"].sort();
    const actualTables = [...present].sort();
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
      throw new Error("public table manifest differs from the reviewed schema");
    }
    for (const item of columns) { const [table, column] = item.split("."); const q = await client.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2", [table, column]); if (!q.rowCount) throw new Error(`missing ${item}`); }
    for (const name of indexes) { const q = await client.query("select 1 from pg_class where relname=$1 union all select 1 from pg_constraint where conname=$1", [name]); if (!q.rowCount) throw new Error(`missing required index or constraint ${name}`); }
    for (const table of TENANT_RLS_TABLES) {
      const q = await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid=$1::regclass", [`public.${table}`]);
      if (q.rows[0]?.relrowsecurity !== true) throw new Error(`RLS is not enabled on ${table}`);
      const p = await client.query("select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname='tenant_isolation' and 'vid_app'=any(roles)", [table]);
      if (!p.rowCount) throw new Error(`vid_app tenant_isolation policy missing on ${table}`);
    }
    const roleRows = await client.query<{
      rolname: string; rolsuper: boolean; rolinherit: boolean; rolcreaterole: boolean;
      rolcreatedb: boolean; rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean;
    }>(`select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
       from pg_roles where rolname in ('vid_app','vid_worker') order by rolname`);
    if (roleRows.rows.length !== 2 || roleRows.rows.some((role) =>
      role.rolsuper || role.rolinherit || role.rolcreaterole || role.rolcreatedb ||
      role.rolcanlogin || role.rolreplication || role.rolbypassrls)) {
      throw new Error("runtime database roles must be NOLOGIN, NOINHERIT, NOSUPERUSER, and NOBYPASSRLS");
    }
    const workerMembership = await client.query<{ ok: boolean }>(
      "select pg_has_role('vid_app','vid_worker','MEMBER') as ok",
    );
    if (!workerMembership.rows[0]?.ok) throw new Error("vid_app must be able to SET ROLE vid_worker");
    const runtimeOwned = await client.query<{ relation: string }>(`
      select c.relname as relation from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','vid_jobs') and c.relkind in ('r','p','S')
        and pg_get_userbyid(c.relowner) in ('vid_app','vid_worker')`);
    if (runtimeOwned.rowCount) throw new Error(`runtime role owns database objects: ${runtimeOwned.rows.map((row) => row.relation).join(", ")}`);
    const grants = await client.query<TableGrant>(`
      select table_name,grantee,privilege_type from information_schema.role_table_grants
      where table_schema='public' and grantee in ('vid_app','vid_worker')
      order by table_name,grantee,privilege_type`);
    const expectedGrants = [
      ...expectedTableGrants(APP_TABLE_PRIVILEGES, "vid_app"),
      ...expectedTableGrants(WORKER_TABLE_PRIVILEGES, "vid_worker"),
    ];
    if (JSON.stringify(sortedGrantKeys(grants.rows)) !== JSON.stringify(sortedGrantKeys(expectedGrants))) {
      throw new Error("public table grants differ from the reviewed least-privilege manifest");
    }
    const columnGrants = await client.query<{ table_name: string; column_name: string; grantee: string; privilege_type: string }>(`
      select c.relname as table_name,a.attname as column_name,pg_get_userbyid(x.grantee) as grantee,x.privilege_type
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(a.attacl) x
      where n.nspname='public' and a.attnum>0 and not a.attisdropped
        and pg_get_userbyid(x.grantee) in ('vid_app','vid_worker')
      order by 1,2,3,4`);
    const expectedColumns = Object.entries(WORKER_COLUMN_PRIVILEGES).flatMap(([key, columns]) => {
      const [table_name, privilege_type] = key.split(".");
      return columns.map((column_name) => ({ table_name: table_name!, column_name, grantee: "vid_worker", privilege_type: privilege_type! }));
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const actualColumns = [...columnGrants.rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      throw new Error("public column grants differ from the reviewed least-privilege manifest");
    }
    const sequenceGrants = await client.query(`
      select 1 from information_schema.role_usage_grants
      where object_schema='public' and object_type='SEQUENCE' and grantee in ('vid_app','vid_worker')`);
    if (sequenceGrants.rowCount) throw new Error("runtime roles must not have public sequence privileges");
    const unsafeDefaults = await client.query(`
      select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
      where pg_get_userbyid(a.grantee) in ('vid_app','vid_worker')
         or (a.grantee=0 and d.defaclobjtype='f' and a.privilege_type='EXECUTE')`);
    if (unsafeDefaults.rowCount) throw new Error("unsafe runtime or PUBLIC default privileges remain");
    const schemaBoundary = await client.query<{ ok: boolean }>(`
      select has_schema_privilege('vid_app','public','usage')
        and not has_schema_privilege('vid_app','public','create')
        and has_schema_privilege('vid_worker','public','usage')
        and not has_schema_privilege('vid_worker','public','create')
        and not exists (
          select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a
          where n.nspname='public' and a.grantee=0 and a.privilege_type='CREATE'
        ) as ok`);
    if (!schemaBoundary.rows[0]?.ok) throw new Error("public schema CREATE must be denied to runtime roles and PUBLIC");
    const auditGrant = await client.query<{ ok: boolean }>("select has_table_privilege('vid_app','public.audit_logs','select,insert') and not has_table_privilege('vid_app','public.audit_logs','update') and not has_table_privilege('vid_app','public.audit_logs','delete') as ok");
    if (!auditGrant.rows[0]?.ok) throw new Error("vid_app audit_logs must be append-only");
    const securityFunctions = await client.query<{
      name: string; security_definer: boolean; volatility: string; config: string[] | null;
      owned_by_runtime_role: boolean;
    }>(`select p.proname as name,p.prosecdef as security_definer,p.provolatile as volatility,p.proconfig as config,
         p.proowner=any(select oid from pg_roles where rolname in ('vid_app','vid_worker')) as owned_by_runtime_role
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=any($1) order by 1`,
      [["lock_thumbnail_cleanup_intent", "lock_thumbnail_cleanup_video", "lookup_acceptable_invitation"]]);
    if (securityFunctions.rows.length !== 3 || securityFunctions.rows.some((fn) =>
      !fn.security_definer || fn.owned_by_runtime_role ||
      !(fn.config ?? []).some((setting) => /^search_path=pg_catalog, ?public$/.test(setting)))) {
      throw new Error("SECURITY DEFINER functions must have non-runtime owners and a fixed safe search_path");
    }
    const functionGrants = await client.query<{ name: string; grantee: string; privilege_type: string }>(`
      select p.proname as name,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,a.privilege_type
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a
      where n.nspname='public' and p.proname=any($1)
        and (a.grantee=0 or pg_get_userbyid(a.grantee) in ('vid_app','vid_worker'))
      order by 1,2,3`,
      [["lock_thumbnail_cleanup_intent", "lock_thumbnail_cleanup_video", "lookup_acceptable_invitation"]]);
    const expectedFunctionGrants = [
      { name: "lock_thumbnail_cleanup_intent", grantee: "vid_worker", privilege_type: "EXECUTE" },
      { name: "lock_thumbnail_cleanup_video", grantee: "vid_worker", privilege_type: "EXECUTE" },
      { name: "lookup_acceptable_invitation", grantee: "vid_app", privilege_type: "EXECUTE" },
    ];
    if (JSON.stringify(functionGrants.rows) !== JSON.stringify(expectedFunctionGrants)) {
      throw new Error("SECURITY DEFINER function grants differ from the reviewed manifest");
    }
    const boss = await client.query<{ version: number }>("select version from vid_jobs.version");
    if (boss.rows.length !== 1 || boss.rows[0]?.version !== 39) throw new Error("vid_jobs must be pg-boss 12.29.0 schema version 39");
    for (const object of ["job","job_common","job_dependency","queue","schedule","subscription","version","bam"]) { const q = await client.query("select 1 from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='vid_jobs' and relname=$1", [object]); if (!q.rowCount) throw new Error(`missing pg-boss managed object vid_jobs.${object}`); }
    const bossGrant = await client.query<{ ok: boolean }>("select has_schema_privilege('vid_app','vid_jobs','usage') and has_table_privilege('vid_app','vid_jobs.job','select,insert,update,delete') as ok");
    if (!bossGrant.rows[0]?.ok) throw new Error("vid_app is missing required vid_jobs runtime grants");
    const final = await catalogFingerprint(client, "masterStorageIntegrity");
    if (EXPECTED_CATALOG_HASHES.masterStorageIntegrity.startsWith("REPLACE_")) throw new Error("masterStorageIntegrity catalog hash is unset; derive it from an isolated clean database");
    if (final.hash !== EXPECTED_CATALOG_HASHES.masterStorageIntegrity) throw new Error(`G15 catalog fingerprint mismatch: ${final.hash}`);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (let index = 1; index < files.length; index++) {
      if (Number(files[index]!.slice(0, 4)) <= Number(files[index - 1]!.slice(0, 4))) {
        throw new Error(`migration numbers must be strictly increasing: ${files[index - 1]}, ${files[index]}`);
      }
    }
    const ledger = await client.query<{ name: string; checksum: string }>("select name,checksum from public.schema_migrations order by name");
    if (ledger.rows.length !== files.length) throw new Error("migration ledger set differs from repository");
    for (const [index, name] of files.entries()) { const checksum = createHash("sha256").update(await readFile(join(dir,name))).digest("hex"); const row=ledger.rows[index]; if(row?.name!==name||row.checksum.trim()!==checksum) throw new Error(`migration ledger mismatch for ${name}`); }
  } finally { await client.end(); }
}
void main().catch((error: unknown) => {
  console.error(formatOperationalError(error));
  process.exitCode = 1;
});