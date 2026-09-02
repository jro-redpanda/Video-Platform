import pg from "pg";
import { catalogFingerprint, EXPECTED_CATALOG_HASHES } from "./catalog.ts";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { Client } = pg;
const tables = ["plans","organizations","organization_customization","users","sessions","accounts","verifications","permission_groups","permissions","group_permissions","memberships","invitations","provider_accounts","provider_tenant_spaces","organization_entitlement_overrides","webhook_events","embed_generation_outbox","audit_logs","folders","videos","video_embeds","video_analytics_rollups","playback_events","thumbnail_upload_intents","object_cleanup_outbox"];
const columns = ["videos.thumbnail_object_key","videos.thumbnail_content_type","videos.thumbnail_size_bytes","object_cleanup_outbox.quarantined_at"];
const indexes = ["videos_org_created_idx","videos_thumbnail_metadata_check","thumbnail_upload_intents_object_key_idx","thumbnail_upload_intents_video_idx","thumbnail_upload_intents_expiry_idx","object_cleanup_outbox_object_key_idx","object_cleanup_outbox_pending_idx"];
const rls = ["organization_customization","permission_groups","memberships","invitations","folders","videos","thumbnail_upload_intents","video_analytics_rollups","playback_events","provider_tenant_spaces","organization_entitlement_overrides","audit_logs"];
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  try {
    const relation = await client.query<{ relname: string }>("select relname from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r'");
    const present = new Set(relation.rows.map((r) => r.relname));
    for (const table of tables) if (!present.has(table)) throw new Error(`missing required table public.${table}`);
    for (const item of columns) { const [table, column] = item.split("."); const q = await client.query("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2", [table, column]); if (!q.rowCount) throw new Error(`missing ${item}`); }
    for (const name of indexes) { const q = await client.query("select 1 from pg_class where relname=$1 union all select 1 from pg_constraint where conname=$1", [name]); if (!q.rowCount) throw new Error(`missing required index or constraint ${name}`); }
    for (const table of rls) { const q = await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid=$1::regclass", [`public.${table}`]); if (q.rows[0]?.relrowsecurity !== true) throw new Error(`RLS is not enabled on ${table}`); const p = await client.query("select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname='tenant_isolation' and 'vid_app'=any(roles)", [table]); if (!p.rowCount) throw new Error(`vid_app tenant_isolation policy missing on ${table}`); }
    const boss = await client.query<{ version: number }>("select version from vid_jobs.version");
    if (boss.rows.length !== 1 || boss.rows[0]?.version !== 39) throw new Error("vid_jobs must be pg-boss 12.29.0 schema version 39");
    for (const object of ["job","job_common","job_dependency","queue","schedule","subscription","version","bam"]) { const q = await client.query("select 1 from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='vid_jobs' and relname=$1", [object]); if (!q.rowCount) throw new Error(`missing pg-boss managed object vid_jobs.${object}`); }
    const bossGrant = await client.query<{ ok: boolean }>("select has_schema_privilege('vid_app','vid_jobs','usage') and has_table_privilege('vid_app','vid_jobs.job','select,insert,update,delete') as ok");
    if (!bossGrant.rows[0]?.ok) throw new Error("vid_app is missing required vid_jobs runtime grants");
    const final = await catalogFingerprint(client, "final");
    if (final.hash !== EXPECTED_CATALOG_HASHES.final) throw new Error(`final catalog fingerprint mismatch: ${final.hash}`);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const ledger = await client.query<{ name: string; checksum: string }>("select name,checksum from public.schema_migrations order by name");
    if (ledger.rows.length !== files.length) throw new Error("migration ledger set differs from repository");
    for (const [index, name] of files.entries()) { const checksum = createHash("sha256").update(await readFile(join(dir,name))).digest("hex"); const row=ledger.rows[index]; if(row?.name!==name||row.checksum.trim()!==checksum) throw new Error(`migration ledger mismatch for ${name}`); }
  } finally { await client.end(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });