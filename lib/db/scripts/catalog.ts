import { createHash } from "node:crypto";
import type pg from "pg";

export type CatalogStage = "pre15" | "step15" | "thumbnailIntegrity" | "final";
const pre = ["accounts","audit_logs","embed_generation_outbox","folders","group_permissions","invitations","memberships","organization_customization","organization_entitlement_overrides","organizations","permission_groups","permissions","plans","playback_events","provider_accounts","provider_tenant_spaces","sessions","users","verifications","video_analytics_rollups","video_embeds","videos","webhook_events"];
const step15 = [...pre, "thumbnail_upload_intents", "object_cleanup_outbox"];
const enums = ["membership_status","organization_status","provider_tenant_space_state","video_status","video_visibility"];
const compact = (value: string | null) => value?.replace(/\s+/g, " ").trim() ?? null;

export async function catalogFingerprint(client: pg.Client, stage: CatalogStage) {
  const tables = stage === "pre15" ? pre : step15;
  const enumRows = await client.query(`select t.typname as name,e.enumsortorder::int as position,e.enumlabel as label from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname=any($1) order by 1,2`, [enums]);
  const relations = await client.query(`select c.relname as name,c.relkind as kind,c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by 1`, [tables]);
  const columns = await client.query(`select c.relname as relation,a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,pg_get_expr(d.adbin,d.adrelid) as default,a.attidentity as identity,a.attgenerated as generated,coll.collname as collation from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum left join pg_collation coll on coll.oid=a.attcollation where n.nspname='public' and c.relname=any($1) order by 1,2`, [tables]);
  const constraints = await client.query(`select c.relname as relation,x.contype as type,pg_get_constraintdef(x.oid,true) as definition,x.confupdtype as update_action,x.confdeltype as delete_action from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by 1,3`, [tables]);
  const indexes = await client.query(`select t.relname as relation,x.indisunique as unique,regexp_replace(pg_get_indexdef(i.oid),'^(CREATE (UNIQUE )?INDEX) [^ ]+ (ON )','\\1 \\3') as definition,pg_get_expr(x.indpred,x.indrelid) as predicate from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and t.relname=any($1) order by 1,3`, [tables]);
  const policies = await client.query(`select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename=any($1) order by 1,2`, [tables]);
  const grants = await client.query(`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=any($1) and grantee='vid_app' order by 1,2,3`, [tables]);
  const projectedColumns = stage === "pre15" ? columns.rows.filter((row) => row.relation !== "videos" || !["thumbnail_object_key","thumbnail_content_type","thumbnail_size_bytes","thumbnail_version"].includes(row.name)) : columns.rows;
  const projectedConstraints = stage === "pre15" ? constraints.rows.filter((row) => row.relation !== "videos" || !String(row.definition).includes("thumbnail_")) : constraints.rows;
  const out: Record<string, unknown> = { enums: enumRows.rows, relations: relations.rows, columns: projectedColumns, constraints: projectedConstraints, indexes: indexes.rows, policies: policies.rows, grants: grants.rows };
  if (stage === "final") {
    const boss = await client.query(`select n.nspname as schema,c.relname as name,c.relkind as kind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='vid_jobs' and not c.relispartition order by 2,3`);
    const functions = await client.query(`select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_function_result(p.oid) as result,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vid_jobs' order by 1,2`);
    const constraints = await client.query(`select c.relname as relation,x.contype as type,pg_get_constraintdef(x.oid,true) as definition,x.confupdtype as update_action,x.confdeltype as delete_action from pg_constraint x join pg_class c on c.oid=x.conrelid where x.connamespace='vid_jobs'::regnamespace and not c.relispartition order by 1,3`);
    const indexes = await client.query(`select t.relname as relation,x.indisunique as unique,regexp_replace(pg_get_indexdef(i.oid),'^(CREATE (UNIQUE )?INDEX) [^ ]+ (ON )','\\1 \\3') as definition,pg_get_expr(x.indpred,x.indrelid) as predicate from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='vid_jobs' and not t.relispartition order by 1,3`);
    const version = await client.query(`select version from vid_jobs.version`);
    const grants = await client.query(`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='vid_jobs' and grantee='vid_app' and table_name !~ '^queue_stats_[0-9]{8}$' union all select routine_name,grantee,privilege_type from information_schema.role_routine_grants where specific_schema='vid_jobs' and grantee='vid_app' order by 1,2,3`);
    out.pgBoss = { objects: boss.rows, functions: functions.rows, constraints: constraints.rows, indexes: indexes.rows, grants: grants.rows, version: version.rows };
  }
  const json = JSON.stringify(out, (_key, value) => typeof value === "string" ? compact(value) : value);
  return { json, hash: createHash("sha256").update(json).digest("hex") };
}

// Generated only from isolated clean databases by scripts/accept-migrations.ts.
export const EXPECTED_CATALOG_HASHES: Record<CatalogStage, string> = {
  pre15: "6b1834d379c66852364e18b5e98022642b80de29f419f39b21d36781d72344a0",
  step15: "bd8e3dd59225fbbd477d57b9a86a41240d520d20aef76ae649742fc652d073b3",
  thumbnailIntegrity: "e3510171bf12540df6629565ea1b084ebe5ba0e13708a75e7a3228bf2a425934",
  final: "464f81dcc06d5069de6b52edc57d5b40d741acfecdf8930f17adfd0d7ab7945f",
};