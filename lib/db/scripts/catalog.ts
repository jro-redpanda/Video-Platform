import { createHash } from "node:crypto";
import type pg from "pg";

export type CatalogStage = "pre15" | "step15" | "thumbnailIntegrity" | "final" | "billingBase" | "billingCheckoutBase" | "billingProviderBase" | "billing" | "analyticsBase" | "analytics" | "audit" | "auditExport" | "onboarding" | "customDomain" | "masterStorage" | "masterArchiveIntegrity" | "g1Identity" | "g3Hardening";
const pre = ["accounts","audit_logs","embed_generation_outbox","folders","group_permissions","invitations","memberships","organization_customization","organization_entitlement_overrides","organizations","permission_groups","permissions","plans","playback_events","provider_accounts","provider_tenant_spaces","sessions","users","verifications","video_analytics_rollups","video_embeds","videos","webhook_events"];
const step15 = [...pre, "thumbnail_upload_intents", "object_cleanup_outbox"];
const billing = [...step15, "organization_billing", "billing_operations", "billing_event_receipts"];
const analyticsBase = [...billing, "analytics_dirty_days", "analytics_rate_windows"];
const analytics = [...analyticsBase, "analytics_playback_sessions"];
const onboarding = [...analytics, "onboarding_provisioning_intents"];
const customDomain = [...onboarding, "custom_domains", "custom_domain_verification_windows"];
const masterStorage = [...customDomain, "master_storage_operations"];
const g3Tables = [...masterStorage, "schema_migrations"];
const enums = ["membership_status","organization_status","provider_tenant_space_state","video_status","video_visibility"];
const billingEnums = [...enums, "billing_status","billing_interval","billing_operation_state"];
const onboardingEnums = [...billingEnums, "onboarding_intent_state"];
const customDomainEnums = [...onboardingEnums, "custom_domain_lifecycle"];
const masterStorageEnums = [...customDomainEnums, "master_storage_operation_kind", "master_storage_operation_state"];
const compact = (value: string | null) => value?.replace(/\s+/g, " ").trim() ?? null;

export async function catalogFingerprint(client: pg.Client, stage: CatalogStage) {
  const analyticsStage = stage === "analytics" || stage === "audit" || stage === "auditExport" || stage === "onboarding" || stage === "customDomain" || stage === "masterStorage" || stage === "masterArchiveIntegrity" || stage === "g1Identity" || stage === "g3Hardening";
  const billingStage = stage === "billing" || stage === "billingBase" || stage === "billingCheckoutBase" || stage === "billingProviderBase" || analyticsStage;
  const tables = stage === "pre15" ? pre : stage === "g3Hardening" ? g3Tables : (stage === "masterStorage" || stage === "masterArchiveIntegrity" || stage === "g1Identity") ? masterStorage : stage === "customDomain" ? customDomain : stage === "onboarding" ? onboarding : analyticsStage ? analytics : stage === "analyticsBase" ? analyticsBase : billingStage ? billing : step15;
  const enumRows = await client.query(`select t.typname as name,e.enumsortorder::int as position,e.enumlabel as label from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname=any($1) order by 1,2`, [(stage === "masterStorage" || stage === "masterArchiveIntegrity" || stage === "g1Identity" || stage === "g3Hardening") ? masterStorageEnums : stage === "customDomain" ? customDomainEnums : stage === "onboarding" ? onboardingEnums : billingStage ? billingEnums : enums]);
  const relations = await client.query(`select c.relname as name,c.relkind as kind,c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by 1`, [tables]);
  const columns = await client.query(`select c.relname as relation,a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,pg_get_expr(d.adbin,d.adrelid) as default,a.attidentity as identity,a.attgenerated as generated,coll.collname as collation from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum left join pg_collation coll on coll.oid=a.attcollation where n.nspname='public' and c.relname=any($1) order by 1,2`, [tables]);
  const constraints = await client.query(`select c.relname as relation,x.contype as type,pg_get_constraintdef(x.oid,true) as definition,x.confupdtype as update_action,x.confdeltype as delete_action from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by 1,3`, [tables]);
  const indexes = await client.query(`select t.relname as relation,x.indisunique as unique,regexp_replace(pg_get_indexdef(i.oid),'^(CREATE (UNIQUE )?INDEX) [^ ]+ (ON )','\\1 \\3') as definition,pg_get_expr(x.indpred,x.indrelid) as predicate from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and t.relname=any($1) order by 1,3`, [tables]);
  const policies = await client.query(`select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename=any($1) order by 1,2`, [tables]);
  const grants = await client.query(`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=any($1) and grantee=any($2) order by 1,2,3`, [tables, stage === "g3Hardening" ? ["vid_app", "vid_worker"] : ["vid_app"]]);
  const projectedColumns = stage === "pre15" ? columns.rows.filter((row) => row.relation !== "videos" || !["thumbnail_object_key","thumbnail_content_type","thumbnail_size_bytes","thumbnail_version"].includes(row.name)) : columns.rows;
  const projectedConstraints = stage === "pre15" ? constraints.rows.filter((row) => row.relation !== "videos" || !String(row.definition).includes("thumbnail_")) : constraints.rows;
  const out: Record<string, unknown> = { enums: enumRows.rows, relations: relations.rows, columns: projectedColumns, constraints: projectedConstraints, indexes: indexes.rows, policies: policies.rows, grants: grants.rows };
  if (stage === "g1Identity" || stage === "g3Hardening") {
    const functions = await client.query(`select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_function_result(p.oid) as result,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lookup_acceptable_invitation' order by 1,2`);
    const functionGrants = await client.query(`select routine_name,grantee,privilege_type from information_schema.role_routine_grants where routine_schema='public' and routine_name='lookup_acceptable_invitation' and grantee='vid_app' order by 1,2,3`);
    out.g1Functions = { functions: functions.rows, grants: functionGrants.rows };
  }
  if (stage === "g3Hardening") {
    const roles = await client.query(`select rolname as name,rolsuper as superuser,rolinherit as inherit,rolcreaterole as create_role,rolcreatedb as create_database,rolcanlogin as login,rolreplication as replication,rolbypassrls as bypass_rls from pg_roles where rolname in ('vid_app','vid_worker') order by 1`);
    const memberships = await client.query(`select parent.rolname as role,member.rolname as member from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member where parent.rolname='vid_worker' and member.rolname='vid_app' order by 1,2`);
    const owners = await client.query(`select c.relname as relation,c.relowner=any(select oid from pg_roles where rolname in ('vid_app','vid_worker')) as owned_by_runtime_role from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1) order by 1`, [tables]);
    const columnGrants = await client.query(`select c.relname as table_name,a.attname as column_name,pg_get_userbyid(x.grantee) as grantee,x.privilege_type from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(a.attacl) x where n.nspname='public' and c.relname=any($1) and a.attnum>0 and not a.attisdropped and pg_get_userbyid(x.grantee)=any($2) order by 1,2,3,4`, [tables, ["vid_app", "vid_worker"]]);
    const functions = await client.query(`select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,p.proowner=any(select oid from pg_roles where rolname in ('vid_app','vid_worker')) as owned_by_runtime_role,p.prosecdef as security_definer,p.provolatile as volatility,p.proconfig as config,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by 1,2`, [["lookup_acceptable_invitation", "lock_thumbnail_cleanup_video", "lock_thumbnail_cleanup_intent"]]);
    const functionGrants = await client.query(`select routine_name,grantee,privilege_type from information_schema.role_routine_grants where routine_schema='public' and routine_name=any($1) and grantee=any($2) order by 1,2,3`, [["lookup_acceptable_invitation", "lock_thumbnail_cleanup_video", "lock_thumbnail_cleanup_intent"], ["PUBLIC", "vid_app", "vid_worker"]]);
    const defaults = await client.query(`select coalesce(n.nspname,'') as schema,d.defaclobjtype as object_type,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,a.privilege_type,a.is_grantable from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)=any($1) order by 1,2,3,4`, [["PUBLIC", "vid_app", "vid_worker"]]);
    const schemas = await client.query(`select r.rolname as role,has_schema_privilege(r.rolname,'public','usage') as usage,has_schema_privilege(r.rolname,'public','create') as create from pg_roles r where r.rolname in ('vid_app','vid_worker') union all select 'PUBLIC',coalesce(bool_or(a.grantee=0 and a.privilege_type='USAGE'),false),coalesce(bool_or(a.grantee=0 and a.privilege_type='CREATE'),false) from pg_namespace n left join lateral aclexplode(n.nspacl) a on true where n.nspname='public' order by 1`);
    const bossSchemas = await client.query(`select r.rolname as role,has_schema_privilege(r.rolname,'vid_jobs','usage') as usage,has_schema_privilege(r.rolname,'vid_jobs','create') as create from pg_roles r where r.rolname in ('vid_app','vid_worker') order by 1`);
    const bossSequences = await client.query(`select c.relname as object_name,pg_get_userbyid(a.grantee) as grantee,a.privilege_type from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname='vid_jobs' and c.relkind='S' and pg_get_userbyid(a.grantee) in ('vid_app','vid_worker') order by 1,2,3`);
    out.g3Security = { roles: roles.rows, memberships: memberships.rows, owners: owners.rows, columnGrants: columnGrants.rows, functions: functions.rows, functionGrants: functionGrants.rows, defaults: defaults.rows, schemas: schemas.rows, bossSchemas: bossSchemas.rows, bossSequences: bossSequences.rows };
  }
  if (stage === "final" || stage === "g3Hardening") {
    const boss = await client.query(`select n.nspname as schema,c.relname as name,c.relkind as kind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='vid_jobs' and not c.relispartition order by 2,3`);
    const functions = await client.query(`select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_function_result(p.oid) as result,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vid_jobs' order by 1,2`);
    const constraints = await client.query(`select c.relname as relation,x.contype as type,pg_get_constraintdef(x.oid,true) as definition,x.confupdtype as update_action,x.confdeltype as delete_action from pg_constraint x join pg_class c on c.oid=x.conrelid where x.connamespace='vid_jobs'::regnamespace and not c.relispartition order by 1,3`);
    const indexes = await client.query(`select t.relname as relation,x.indisunique as unique,regexp_replace(pg_get_indexdef(i.oid),'^(CREATE (UNIQUE )?INDEX) [^ ]+ (ON )','\\1 \\3') as definition,pg_get_expr(x.indpred,x.indrelid) as predicate from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='vid_jobs' and not t.relispartition order by 1,3`);
    const version = await client.query(`select version from vid_jobs.version`);
    const grants = await client.query(`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='vid_jobs' and grantee=any($1) and table_name !~ '^queue_stats_[0-9]{8}$' union all select routine_name,grantee,privilege_type from information_schema.role_routine_grants where specific_schema='vid_jobs' and grantee=any($1) order by 1,2,3`, [["vid_app", "vid_worker"]]);
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
  billingBase: "e523e5f60f8a77d7aea220eaa67d55e4ecea2dea24b330466a4686d20df68f82",
  billingCheckoutBase: "622aef0183be3f3f2e880bd6c59ee404be72b38ad4caf43f3812dfb9dc96e3ad",
  billingProviderBase: "0fd3b5c64b0bdb8e19a6cecb4d97c2989032a8209f946b491a9c9c2831b7a88d",
  billing: "8097cb64e4fd023769dafd8c8da86c8d30ea560456504e0c64db49f9296d4ee2",
  analytics: "1e3b1a54d5814cadf5f3d575758a0e4965c8d8b20192c5441d556c14d761afc1",
  analyticsBase: "97eea02ba9e957bb52fa293007c22b7dec7f088c71295f386594b7a2d6214eec",
  audit: "9c81b785d8180cae9e867311df88726c7590f60eb31cf7e4a0456c47e0ea9076",
  auditExport: "d487c687729bc68b2ef81a4de096dcf570be8f488031c0229725486525562d20",
  onboarding: "3d66798599bbe89c9ad4acc20af8c1db92f2f632ab2a845bd98854839df3529c",
  customDomain: "0560854d1ab26f269086bfa65944a274f9cff17c2bc1dc4cadfdfd9c322089c9",
  // Replace only through `pnpm --filter @workspace/db accept-migrations` on an isolated clean database.
  masterStorage: "03fd1d283665b6f486a8edc69c441771ae61077839757c1b79290cb37c3414d0",
  // Derive only through accept-migrations on an isolated clean database.
  masterArchiveIntegrity: "0bf60707a959e43ed58da9ccc3d3d939121b5f5c2f6b8508d36151069f94eb98",
  g1Identity: "a0223c189f937c60e7a55da6a2552962d94ef82f3575081274cb01f5d39bdd3b",
  g3Hardening: "796260bfa658301d2be21fe446efea2a31ab5f9cd8cc18cdc99539668a20c481",
};