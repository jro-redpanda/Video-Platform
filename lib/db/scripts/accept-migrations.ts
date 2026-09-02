import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgBoss } from "pg-boss";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = `vid_migration_accept_${randomUUID().replaceAll("-", "").slice(0,12)}`;
const admin = process.env.DATABASE_URL;
const url = (database: string) => { const value=new URL(admin); value.pathname=`/${database}`; return value.href; };
const run = (file: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync(file,args,{stdio:"pipe",env:{...process.env,...env}});
const created: string[] = [];
// Never clone a live database: independently migrate every isolated test DB.
// This is slower than CREATE DATABASE ... TEMPLATE but deterministic under CI
// and cannot terminate or change connectivity for any non-test database.
const create = (name: string, migratedLike?: string) => {
  run("createdb",[`--maintenance-db=${admin}`,name]);
  created.push(name);
  if (migratedLike) {
    if (!migratedLike.startsWith(prefix)) throw new Error("refusing to derive a non-test database");
    run("node",["--experimental-strip-types","scripts/migrate.ts"],{DATABASE_URL:url(name)});
  }
};
const sql = (database: string, statement: string) => run("psql",[url(database),"-v","ON_ERROR_STOP=1","-c",statement]);
const verifyFails = (database: string) => { try { run("node",["--experimental-strip-types","scripts/verify-schema.ts"],{DATABASE_URL:url(database)}); throw new Error("verification unexpectedly accepted corruption"); } catch (error) { if (error instanceof Error && error.message.includes("unexpectedly")) throw error; } };
const adoptFailsWithout0020 = (database: string) => {
  try { run("node",["--experimental-strip-types","scripts/migrate.ts","adopt-baseline","--confirm"],{DATABASE_URL:url(database)}); throw new Error("adoption unexpectedly accepted corruption"); } catch (error) { if (error instanceof Error && error.message.includes("unexpectedly")) throw error; }
  const count = run("psql",[url(database),"-Atc","select count(*) from schema_migrations where name='0020_pgboss_12_29_0.sql'"]).toString().trim();
  if (count !== "0") throw new Error("failed pg-boss adoption wrote the 0020 ledger row");
};
try {
  const preservation=`${prefix}_preserve`; create(preservation);
  run("psql",[url(preservation),"-v","ON_ERROR_STOP=1","-f","migrations/0000_baseline.sql"]);
  run("psql",[url(preservation),"-v","ON_ERROR_STOP=1","-f","migrations/0015_thumbnails.sql"]);
  sql(preservation,`
    insert into plans(id,code,name,storage_limit_gb) values('10000000-0000-0000-0000-000000000001','fixture','Fixture',1);
    insert into organizations(id,name,slug,plan_id) values('20000000-0000-0000-0000-000000000002','Fixture','fixture','10000000-0000-0000-0000-000000000001');
    insert into videos(id,organization_id,title,thumbnail_object_key,thumbnail_content_type,thumbnail_size_bytes)
      values('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','Legacy','thumbnails/20000000-0000-0000-0000-000000000002/30000000-0000-0000-0000-000000000003/legacy','image/jpeg',5);
    insert into thumbnail_upload_intents(id,organization_id,video_id,object_key,declared_content_type,declared_size_bytes,expires_at)
      values('40000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','thumbnails/20000000-0000-0000-0000-000000000002/30000000-0000-0000-0000-000000000003/legacy','image/jpeg',5,now()+interval '5 minutes');
  `);
  run("psql",[url(preservation),"-v","ON_ERROR_STOP=1","-f","migrations/0016_thumbnail_integrity.sql"]);
  sql(preservation,`do $$ declare v videos%rowtype; begin
    select * into strict v from videos where id='30000000-0000-0000-0000-000000000003';
    if v.thumbnail_object_key is distinct from 'thumbnails/20000000-0000-0000-0000-000000000002/30000000-0000-0000-0000-000000000003/legacy'
      or v.thumbnail_content_type is distinct from 'image/jpeg' or v.thumbnail_size_bytes is distinct from 5
      or v.thumbnail_version is null or v.thumbnail_mutable_until is null then raise exception 'legacy metadata was not preserved'; end if;
    if now() >= v.thumbnail_mutable_until then raise exception 'legacy thumbnail exposed before safety horizon'; end if;
    update videos set thumbnail_mutable_until=now()-interval '1 second' where id=v.id returning * into v;
    if not (v.thumbnail_mutable_until is null or v.thumbnail_mutable_until <= now()) then raise exception 'legacy thumbnail cannot become accessible after safety horizon'; end if;
    if v.thumbnail_object_key is distinct from 'thumbnails/20000000-0000-0000-0000-000000000002/30000000-0000-0000-0000-000000000003/legacy' then raise exception 'safety horizon changed active key'; end if;
    if (select count(*) from thumbnail_upload_intents where video_id=v.id) <> 1 then raise exception 'legacy intent was not preserved'; end if;
    if exists(select 1 from object_cleanup_outbox where object_key=v.thumbnail_object_key) then raise exception 'active legacy key was enqueued'; end if;
  end $$;`);
  create(prefix); run("node",["--experimental-strip-types","scripts/migrate.ts"],{DATABASE_URL:url(prefix)});
  run("node",["--experimental-strip-types","scripts/migrate.ts"],{DATABASE_URL:url(prefix)});
  const mutations = [
    "alter table videos alter column title type varchar(500)",
    "alter table videos alter column description drop default",
    "alter table videos alter column title drop not null",
    "alter table videos drop constraint videos_organization_id_fkey; alter table videos add constraint videos_organization_id_fkey foreign key(organization_id) references organizations(id)",
    "drop index folders_org_root_name_ci_idx; create unique index folders_org_root_name_ci_idx on folders(organization_id,lower(name))",
    "drop policy tenant_isolation on videos; create policy tenant_isolation on videos to public using(true)",
    "alter table thumbnail_upload_intents alter column object_key type varchar(100)",
    "drop index thumbnail_upload_intents_video_idx; create index thumbnail_upload_intents_video_idx on thumbnail_upload_intents(video_id)",
    "insert into schema_migrations values('9999_unknown.sql',repeat('0',64),now())",
    "update schema_migrations set checksum=repeat('0',64) where name='0015_thumbnails.sql'",
    "update vid_jobs.version set version=38",
  ];
  for (let index=0; index<mutations.length; index++) { const db=`${prefix}_${index}`; create(db,prefix); sql(db,mutations[index]!); verifyFails(db); }
  for (const [suffix, mutation] of [["function","create or replace function vid_jobs.delete_queue(queue_name text) returns void language sql as 'select'"],["index","drop index vid_jobs.job_common_i1"],["constraint","alter table vid_jobs.queue drop constraint queue_check"]] as const) {
    const db=`${prefix}_${suffix}`; create(db,prefix);
    sql(db,"delete from schema_migrations where name='0020_pgboss_12_29_0.sql'; "+mutation);
    adoptFailsWithout0020(db);
  }
  const limited = new URL(url(prefix)); limited.searchParams.set("options","-c role=vid_app");
  const boss = new PgBoss({connectionString:limited.href,schema:"vid_jobs",migrate:false}); await boss.start(); await boss.stop();
} finally {
  for (const database of created.reverse()) try { run("dropdb",[`--maintenance-db=${admin}`,"--force",database]); } catch {}
}