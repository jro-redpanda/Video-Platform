import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { catalogFingerprint, EXPECTED_CATALOG_HASHES } from "./catalog.ts";
import {
  APP_TABLE_PRIVILEGES,
  TENANT_RLS_TABLES,
  WORKER_COLUMN_PRIVILEGES,
  WORKER_TABLE_PRIVILEGES,
} from "./security-manifest.ts";
import { missingRequiredApiMigrations } from "../../../artifacts/api-server/src/lib/migration-gate.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Grant = { table_name: string; grantee: string; privilege_type: string };
const grantKeys = (grants: Grant[]) =>
  grants.map((grant) => `${grant.table_name}:${grant.grantee}:${grant.privilege_type}`).sort();
const expectedGrants = (manifest: Record<string, readonly string[]>, grantee: string) =>
  Object.entries(manifest).flatMap(([table_name, privileges]) =>
    privileges.map((privilege_type) => ({ table_name, grantee, privilege_type })));

async function expectDenied(statement: string, code = "42501") {
  await client.query("savepoint expected_denial");
  try {
    await client.query(statement);
    await client.query("rollback to savepoint expected_denial");
    throw new Error(`statement unexpectedly succeeded: ${statement}`);
  } catch (error) {
    await client.query("rollback to savepoint expected_denial");
    assert.equal((error as { code?: string }).code, code);
  } finally {
    await client.query("release savepoint expected_denial");
  }
}

async function scalar(statement: string, values: unknown[] = []) {
  const result = await client.query<{ count: string }>(statement, values);
  return Number(result.rows[0]?.count ?? 0);
}

await client.connect();
try {
  await client.query("begin");
  const identityName = "0033_g1_identity_integrity.sql";
  const identityBytes = await readFile(join(root, "migrations", identityName));
  await client.query(identityBytes.toString("utf8"));
  await client.query(
    "insert into schema_migrations(name,checksum) values($1,$2)",
    [identityName, createHash("sha256").update(identityBytes).digest("hex")],
  );
  let appliedMigrations = await client.query<{ name: string }>("select name from schema_migrations");
  assert.deepEqual(missingRequiredApiMigrations(appliedMigrations.rows.map((row) => row.name)), [
    "0034_g3_database_hardening.sql",
  ]);

  const hardeningName = "0034_g3_database_hardening.sql";
  const hardeningBytes = await readFile(join(root, "migrations", hardeningName));
  await client.query(hardeningBytes.toString("utf8"));
  await client.query(
    "insert into schema_migrations(name,checksum) values($1,$2)",
    [hardeningName, createHash("sha256").update(hardeningBytes).digest("hex")],
  );
  appliedMigrations = await client.query<{ name: string }>("select name from schema_migrations");
  assert.deepEqual(missingRequiredApiMigrations(appliedMigrations.rows.map((row) => row.name)), []);

  const fingerprint = await catalogFingerprint(client, "g3Hardening");
  assert.equal(fingerprint.hash, EXPECTED_CATALOG_HASHES.g3Hardening);

  const roleRows = await client.query<{
    rolname: string; rolsuper: boolean; rolinherit: boolean; rolcreaterole: boolean;
    rolcreatedb: boolean; rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean;
  }>(`select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
     from pg_roles where rolname in ('vid_app','vid_worker') order by rolname`);
  assert.equal(roleRows.rows.length, 2);
  assert.equal(roleRows.rows.some((role) =>
    role.rolsuper || role.rolinherit || role.rolcreaterole || role.rolcreatedb ||
    role.rolcanlogin || role.rolreplication || role.rolbypassrls), false);

  const rlsRows = await client.query<{ relname: string }>(`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1) and c.relrowsecurity
    order by c.relname`, [[...TENANT_RLS_TABLES]]);
  assert.deepEqual(rlsRows.rows.map((row) => row.relname), [...TENANT_RLS_TABLES].sort());
  const tenantPolicies = await client.query<{ tablename: string }>(`
    select tablename from pg_policies
    where schemaname='public' and tablename=any($1)
      and policyname='tenant_isolation' and 'vid_app'=any(roles)
    order by tablename`, [[...TENANT_RLS_TABLES]]);
  assert.deepEqual(tenantPolicies.rows.map((row) => row.tablename), [...TENANT_RLS_TABLES].sort());

  const actualGrants = await client.query<Grant>(`
    select table_name,grantee,privilege_type from information_schema.role_table_grants
    where table_schema='public' and grantee in ('vid_app','vid_worker')
    order by table_name,grantee,privilege_type`);
  assert.deepEqual(
    grantKeys(actualGrants.rows),
    grantKeys([
      ...expectedGrants(APP_TABLE_PRIVILEGES, "vid_app"),
      ...expectedGrants(WORKER_TABLE_PRIVILEGES, "vid_worker"),
    ]),
  );
  const actualColumnGrants = await client.query<{
    table_name: string; column_name: string; grantee: string; privilege_type: string;
  }>(`select c.relname as table_name,a.attname as column_name,pg_get_userbyid(x.grantee) as grantee,x.privilege_type
     from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
     cross join lateral aclexplode(a.attacl) x
     where n.nspname='public' and a.attnum>0 and not a.attisdropped
       and pg_get_userbyid(x.grantee) in ('vid_app','vid_worker')
     order by 1,2,3,4`);
  const expectedColumnGrants = Object.entries(WORKER_COLUMN_PRIVILEGES).flatMap(([key, columns]) => {
    const [table_name, privilege_type] = key.split(".");
    return columns.map((column_name) => ({
      table_name: table_name!, column_name, grantee: "vid_worker", privilege_type: privilege_type!,
    }));
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(
    [...actualColumnGrants.rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    expectedColumnGrants,
  );

  const ids = {
    plan: randomUUID(),
    organizationA: randomUUID(), organizationB: randomUUID(), organizationC: randomUUID(),
    userA: randomUUID(), userB: randomUUID(), userC: randomUUID(),
    groupA: randomUUID(), groupB: randomUUID(), groupC: randomUUID(),
    accountA: randomUUID(), accountB: randomUUID(),
    spaceA: randomUUID(), spaceB: randomUUID(),
    videoA: randomUUID(), videoB: randomUUID(),
    webhookA: randomUUID(), webhookB: randomUUID(),
  };
  await client.query(
    "insert into plans(id,code,name,storage_limit_gb) values($1,$2,'G3 fixture',1)",
    [ids.plan, `g3-${randomUUID()}`],
  );
  await client.query(
    `insert into organizations(id,name,slug,status,plan_id) values
      ($1,'G3 A',$3,'active',$5),($2,'G3 B',$4,'active',$5)`,
    [ids.organizationA, ids.organizationB, `g3-a-${randomUUID()}`, `g3-b-${randomUUID()}`, ids.plan],
  );
  await client.query(
    `insert into users(id,email,name,email_verified) values
      ($1,$4,'G3 A',true),($2,$5,'G3 B',true),($3,$6,'G3 C',true)`,
    [
      ids.userA, ids.userB, ids.userC,
      `g3-a-${randomUUID()}@example.test`,
      `g3-b-${randomUUID()}@example.test`,
      `g3-c-${randomUUID()}@example.test`,
    ],
  );
  await client.query(
    `insert into permission_groups(id,organization_id,name) values
      ($1,$3,'G3 A'),($2,$4,'G3 B')`,
    [ids.groupA, ids.groupB, ids.organizationA, ids.organizationB],
  );
  await client.query(
    `insert into memberships(organization_id,user_id,group_id,status) values
      ($1,$3,$5,'active'),($2,$4,$6,'active')`,
    [ids.organizationA, ids.organizationB, ids.userA, ids.userB, ids.groupA, ids.groupB],
  );
  await client.query(
    `insert into provider_accounts(id,provider_key,label,encrypted_credentials,max_zones) values
      ($1,'fixture','G3 A','sealed',1),($2,'fixture','G3 B','sealed',1)`,
    [ids.accountA, ids.accountB],
  );
  await client.query(
    `insert into provider_tenant_spaces(id,organization_id,provider_account_id,idempotency_key,state) values
      ($1,$3,$5,$7,'created'),($2,$4,$6,$8,'created')`,
    [ids.spaceA, ids.spaceB, ids.organizationA, ids.organizationB, ids.accountA, ids.accountB, randomUUID(), randomUUID()],
  );
  await client.query(
    `insert into videos(id,organization_id,title) values ($1,$3,'G3 A'),($2,$4,'G3 B')`,
    [ids.videoA, ids.videoB, ids.organizationA, ids.organizationB],
  );
  await client.query(
    `insert into video_embeds(video_id,embed_path,generation_version,generation_status,generated_metadata) values
      ($1,$3,1,'ready','{}'),($2,$4,1,'ready','{}')`,
    [ids.videoA, ids.videoB, `/g3/${ids.videoA}`, `/g3/${ids.videoB}`],
  );
  await client.query(
    `insert into webhook_events(id,provider_key,receipt_digest,provider_event_id,organization_id,signature_valid,verification_state,processing_state) values
      ($1,'fixture',$5,$7,$3,true,'verified','processed'),
      ($2,'fixture',$6,$8,$4,true,'verified','processed')`,
    [ids.webhookA, ids.webhookB, ids.organizationA, ids.organizationB, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  );
  await client.query(
    `insert into embed_generation_outbox(webhook_event_id,video_id) values ($1,$3),($2,$4)`,
    [ids.webhookA, ids.webhookB, ids.videoA, ids.videoB],
  );
  await client.query(
    `insert into onboarding_provisioning_intents(organization_id,requested_by_user_id) values
      ($1,$3),($2,$4)`,
    [ids.organizationA, ids.organizationB, ids.userA, ids.userB],
  );
  await client.query(
    `insert into organization_billing(organization_id,current_plan_id,stripe_customer_id) values
      ($1,$3,$4),($2,$3,$5)`,
    [ids.organizationA, ids.organizationB, ids.plan, `cus_g3_${randomUUID()}`, `cus_g3_${randomUUID()}`],
  );
  await client.query(
    `insert into analytics_dirty_days(organization_id,video_id,day) values
      ($1,$3,current_date),($2,$4,current_date)`,
    [ids.organizationA, ids.organizationB, ids.videoA, ids.videoB],
  );

  await client.query("set local role vid_app");
  await client.query("select set_config('app.user_id',$1,true)", [ids.userC]);
  await client.query("select set_config('app.organization_id',$1,true)", [ids.organizationC]);
  assert.equal(await scalar("select count(*)::text as count from memberships"), 0);
  await client.query(
    `insert into organizations(id,name,slug,status,plan_id)
     values($1,'G3 pretenant',$2,'provisioning',$3)`,
    [ids.organizationC, `g3-c-${randomUUID()}`, ids.plan],
  );
  await client.query(
    `insert into permissions(key,description) values('videos.read','View the video library')
     on conflict(key) do nothing`,
  );
  await client.query(
    "insert into organization_customization(organization_id) values($1)",
    [ids.organizationC],
  );
  await client.query(
    `insert into permission_groups(id,organization_id,name,system_key)
     values($1,$2,'Owners','owners')`,
    [ids.groupC, ids.organizationC],
  );
  await client.query(
    "insert into group_permissions(group_id,permission_key) values($1,'videos.read')",
    [ids.groupC],
  );
  await client.query(
    `insert into memberships(organization_id,user_id,group_id,status)
     values($1,$2,$3,'active')`,
    [ids.organizationC, ids.userC, ids.groupC],
  );
  await client.query(
    `insert into onboarding_provisioning_intents(organization_id,requested_by_user_id)
     values($1,$2)`,
    [ids.organizationC, ids.userC],
  );
  const selfDomain = `g3-${randomUUID()}.example.test`;
  await client.query(
    `insert into custom_domains(
      organization_id,hostname,challenge_name,challenge_value,lifecycle_state,verified_at
    ) values($1,$2,$3,$4,'verified',now())`,
    [ids.organizationC, selfDomain, `_video-verify.${selfDomain}`, randomUUID()],
  );
  await client.query("select set_config('app.organization_id','',true)");
  assert.equal(await scalar("select count(*)::text as count from memberships where user_id=$1", [ids.userC]), 1);
  assert.equal(await scalar("select count(*)::text as count from organizations where id=$1", [ids.organizationC]), 1);
  assert.equal(await scalar(
    "select count(*)::text as count from onboarding_provisioning_intents where requested_by_user_id=$1",
    [ids.userC],
  ), 1);
  assert.equal(await scalar(
    "select count(*)::text as count from custom_domains where hostname=$1 and lifecycle_state='verified'",
    [selfDomain],
  ), 1);
  await client.query("reset role");

  await client.query("set local role vid_app");
  await client.query("select set_config('app.user_id',$1,true)", [ids.userA]);
  await client.query("select set_config('app.organization_id',$1,true)", [ids.organizationA]);
  for (const table of ["organizations", "users", "provider_accounts", "videos", "video_embeds", "webhook_events", "embed_generation_outbox", "organization_billing"]) {
    assert.equal(await scalar(`select count(*)::text as count from ${table}`), 1, `${table} must expose only tenant A`);
  }
  assert.equal(
    (await client.query("update organizations set name='forbidden' where id=$1", [ids.organizationB])).rowCount,
    0,
  );
  await client.query("select set_config('app.onboarding_worker','on',true)");
  assert.equal(
    await scalar("select count(*)::text as count from onboarding_provisioning_intents"),
    1,
    "a forged worker setting must not bypass tenant RLS while current_user is vid_app",
  );
  await expectDenied("select * from accounts");
  await expectDenied("insert into schema_migrations(name,checksum) values('9999_forbidden.sql',repeat('0',64))");
  await expectDenied("update audit_logs set action='forbidden'");

  await client.query("select set_config('app.organization_id','',true)");
  await client.query("select set_config('app.user_id','',true)");
  await client.query("select set_config('app.onboarding_worker','',true)");
  assert.equal(await scalar("select count(*)::text as count from organizations"), 0);
  assert.equal(await scalar("select count(*)::text as count from videos"), 0);

  await client.query("reset role");
  await client.query("set local role vid_worker");
  assert.equal(await scalar("select count(*)::text as count from onboarding_provisioning_intents"), 0);
  await client.query("select set_config('app.onboarding_worker','on',true)");
  assert.equal(await scalar(
    "select count(*)::text as count from onboarding_provisioning_intents where organization_id in ($1,$2)",
    [ids.organizationA, ids.organizationB],
  ), 2);
  assert.equal(await scalar(
    "select count(*)::text as count from provider_accounts where id in ($1,$2)",
    [ids.accountA, ids.accountB],
  ), 2);
  assert.equal(
    (await client.query("update provider_accounts set zone_count_cached=zone_count_cached where id=$1", [ids.accountA])).rowCount,
    1,
  );
  assert.equal(
    (await client.query("update provider_tenant_spaces set updated_at=now() where id=$1", [ids.spaceA])).rowCount,
    1,
  );
  await client.query(
    `insert into organization_customization(organization_id)
     values($1) on conflict(organization_id) do nothing`,
    [ids.organizationA],
  );
  await client.query(
    `insert into group_permissions(group_id,permission_key)
     values($1,'videos.read') on conflict do nothing`,
    [ids.groupA],
  );
  assert.equal(await scalar("select count(*)::text as count from permissions"), 9);
  assert.equal(await scalar("select count(*)::text as count from video_embeds"), 0);
  await expectDenied("select * from users");

  await client.query("select set_config('app.onboarding_worker','',true)");
  await client.query("select set_config('app.upload_expiry_worker','on',true)");
  assert.equal(await scalar("select count(*)::text as count from videos where id in ($1,$2)", [ids.videoA, ids.videoB]), 2);
  assert.equal(await scalar("select count(*)::text as count from provider_tenant_spaces where id in ($1,$2)", [ids.spaceA, ids.spaceB]), 2);
  assert.equal(await scalar("select count(*)::text as count from provider_accounts where id in ($1,$2)", [ids.accountA, ids.accountB]), 2);
  assert.equal(
    (await client.query("update videos set updated_at=now() where id=$1", [ids.videoA])).rowCount,
    1,
  );
  assert.equal(
    (await client.query("update organizations set updated_at=now() where id=$1", [ids.organizationA])).rowCount,
    1,
  );
  assert.equal(
    (await client.query("update provider_accounts set zone_count_cached=zone_count_cached where id=$1", [ids.accountA])).rowCount,
    0,
    "upload cleanup must not mutate provider account capacity",
  );
  assert.equal(await scalar("select count(*)::text as count from embed_generation_outbox where video_id in ($1,$2)", [ids.videoA, ids.videoB]), 0);

  await client.query("select set_config('app.upload_expiry_worker','',true)");
  await client.query("select set_config('app.embed_worker','on',true)");
  assert.equal(await scalar("select count(*)::text as count from videos where id in ($1,$2)", [ids.videoA, ids.videoB]), 2);
  assert.equal(await scalar("select count(*)::text as count from video_embeds where video_id in ($1,$2)", [ids.videoA, ids.videoB]), 2);
  assert.equal(await scalar("select count(*)::text as count from embed_generation_outbox where video_id in ($1,$2)", [ids.videoA, ids.videoB]), 2);
  assert.equal(
    (await client.query("update embed_generation_outbox set updated_at=now() where video_id=$1", [ids.videoA])).rowCount,
    1,
  );
  assert.equal(
    (await client.query("update videos set updated_at=now() where id=$1", [ids.videoA])).rowCount,
    0,
    "embed workers must not mutate video rows",
  );
  assert.equal(await scalar("select count(*)::text as count from provider_accounts where id in ($1,$2)", [ids.accountA, ids.accountB]), 0);

  await client.query("select set_config('app.embed_worker','',true)");
  await client.query("select set_config('app.analytics_worker','on',true)");
  assert.equal(await scalar("select count(*)::text as count from videos where id in ($1,$2)", [ids.videoA, ids.videoB]), 2);
  assert.equal(await scalar(
    "select count(*)::text as count from analytics_dirty_days where organization_id in ($1,$2)",
    [ids.organizationA, ids.organizationB],
  ), 2);
  assert.equal(
    (await client.query("update analytics_dirty_days set claimed_at=now() where organization_id=$1", [ids.organizationA])).rowCount,
    1,
  );
  await client.query(
    `insert into video_analytics_rollups(
      organization_id,video_id,day,plays,unique_sessions,watch_time_seconds,completions,completion_rate
    ) values($1,$2,current_date,0,0,0,0,0)`,
    [ids.organizationA, ids.videoA],
  );
  assert.equal(
    (await client.query("update videos set updated_at=now() where id=$1", [ids.videoA])).rowCount,
    0,
    "analytics workers must not mutate video rows",
  );

  await client.query("select set_config('app.analytics_worker','',true)");
  await client.query("select set_config('app.billing_worker','on',true)");
  assert.equal(await scalar(
    "select count(*)::text as count from organization_billing where organization_id in ($1,$2)",
    [ids.organizationA, ids.organizationB],
  ), 2);
  assert.equal(await scalar("select count(*)::text as count from plans where id=$1", [ids.plan]), 1);
  assert.equal(
    (await client.query("update organization_billing set last_reconciled_at=now() where organization_id=$1", [ids.organizationA])).rowCount,
    1,
  );
  assert.equal(
    (await client.query("update organizations set updated_at=now() where id=$1", [ids.organizationA])).rowCount,
    1,
  );
  assert.equal(await scalar("select count(*)::text as count from videos where id in ($1,$2)", [ids.videoA, ids.videoB]), 0);
  assert.equal(await scalar("select count(*)::text as count from provider_accounts where id in ($1,$2)", [ids.accountA, ids.accountB]), 0);

  await client.query("reset role");
  const unsafeFunctionGrants = await client.query(`
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    where n.nspname='public'
      and p.proname in ('lookup_acceptable_invitation','lock_thumbnail_cleanup_video','lock_thumbnail_cleanup_intent')
      and a.grantee=0 and a.privilege_type='EXECUTE'`);
  assert.equal(unsafeFunctionGrants.rowCount, 0);

  const migrationNames = (await readdir(join(root, "migrations")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const ledger = await client.query<{ name: string; checksum: string }>(
    "select name,checksum from schema_migrations order by name",
  );
  assert.equal(ledger.rows.length, migrationNames.length);
  for (const [index, name] of migrationNames.entries()) {
    const checksum = createHash("sha256").update(await readFile(join(root, "migrations", name))).digest("hex");
    assert.equal(ledger.rows[index]?.name, name);
    assert.equal(ledger.rows[index]?.checksum.trim(), checksum);
  }
  const workerSources = [
    "jobs.ts",
    "billing-reconciliation.ts",
    "tenant-provisioning.ts",
    "upload-expiry-cleanup.ts",
    "video-embeds.ts",
    "analytics-rollup.ts",
    "custom-domain.ts",
    "master-storage-operations.ts",
    "provider-registry.ts",
    "thumbnail-cleanup.ts",
  ];
  const apiLib = join(root, "..", "..", "artifacts", "api-server", "src", "lib");
  for (const name of workerSources) {
    const source = await readFile(join(apiLib, name), "utf8");
    assert.equal(
      /\bdb\.(?:select|insert|update|delete|execute|transaction)\b/.test(source),
      false,
      `${name} bypasses the scoped worker database boundary`,
    );
  }

  await client.query("rollback");
  console.log("G3 rollback-only database smoke passed");
} catch (error) {
  try { await client.query("rollback"); } catch {}
  throw error;
} finally {
  await client.end();
}