-- DEVELOPMENT-ONLY REWRITE (0016 was never committed or deployed).
-- This version supersedes the earlier local destructive draft. Existing
-- thumbnail metadata, intents, and object keys are deliberately preserved.
alter table videos add column if not exists thumbnail_version uuid;
alter table videos add column if not exists thumbnail_generation text;
alter table videos add column if not exists thumbnail_mutable_until timestamptz;
alter table thumbnail_upload_intents add column if not exists finalized_object_key text;
alter table thumbnail_upload_intents add column if not exists finalized_version uuid;
alter table thumbnail_upload_intents add column if not exists finalized_content_type text;
alter table thumbnail_upload_intents add column if not exists finalized_size_bytes integer;
alter table thumbnail_upload_intents add column if not exists finalized_generation text;
alter table object_cleanup_outbox add column if not exists organization_id uuid;

update object_cleanup_outbox o set organization_id = i.organization_id
from thumbnail_upload_intents i where i.object_key=o.object_key and o.organization_id is null;
update object_cleanup_outbox o set organization_id = v.organization_id
from videos v where v.thumbnail_object_key=o.object_key and o.organization_id is null;
update object_cleanup_outbox set organization_id=(split_part(object_key,'/',2))::uuid
where organization_id is null and split_part(object_key,'/',2) ~ '^[0-9a-fA-F-]{36}$';
do $$ begin
  if exists(select 1 from object_cleanup_outbox where organization_id is null) then
    raise exception 'cannot safely assign organization to existing cleanup outbox row';
  end if;
end $$;
alter table object_cleanup_outbox alter column organization_id set not null;

-- Legacy active objects were themselves signed upload destinations. Keep them
-- intact, but suppress serving until every signed capability for that exact
-- key has expired. New server-promoted finals always store a null horizon.
update videos v set
  thumbnail_version=coalesce(v.thumbnail_version,gen_random_uuid()),
  thumbnail_mutable_until=(
    select max(i.expires_at) from thumbnail_upload_intents i
    where i.organization_id=v.organization_id
      and i.video_id=v.id
      and i.object_key=v.thumbnail_object_key
  )
where v.thumbnail_object_key is not null
  and v.thumbnail_content_type is not null
  and v.thumbnail_size_bytes is not null;

alter table videos drop constraint if exists videos_thumbnail_metadata_check;
alter table videos add constraint videos_thumbnail_metadata_check check (
 (thumbnail_object_key is null and thumbnail_content_type is null and thumbnail_size_bytes is null
   and thumbnail_version is null and thumbnail_generation is null and thumbnail_mutable_until is null)
 or (thumbnail_object_key is not null and thumbnail_content_type in ('image/jpeg','image/png','image/webp')
   and thumbnail_size_bytes between 1 and 10485760 and thumbnail_version is not null)
);
alter table thumbnail_upload_intents drop constraint if exists thumbnail_upload_intents_key_check;
alter table thumbnail_upload_intents add constraint thumbnail_upload_intents_key_check check(
  (object_key like 'thumbnails/%' or object_key like 'thumbnail-candidates/%')
  and object_key not like '%..%'
);

drop index if exists object_cleanup_outbox_pending_idx;
create index object_cleanup_outbox_pending_idx
 on object_cleanup_outbox(completed_at,quarantined_at,next_attempt_at);
create index if not exists object_cleanup_outbox_org_idx on object_cleanup_outbox(organization_id,created_at);

do $$ begin
  if not exists(select 1 from pg_roles where rolname='vid_worker') then
    create role vid_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
alter role vid_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role vid_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant vid_worker to vid_app;
do $$ begin execute format('grant vid_app to %I',current_user); end $$;
grant usage on schema public to vid_worker;
revoke all on object_cleanup_outbox,thumbnail_upload_intents,videos from vid_worker;
grant select,insert,delete on object_cleanup_outbox to vid_worker;
grant update(attempts,next_attempt_at,last_error,completed_at,quarantined_at,updated_at)
 on object_cleanup_outbox to vid_worker;
grant select,delete on thumbnail_upload_intents to vid_worker;
grant select on videos to vid_worker;

create or replace function lock_thumbnail_cleanup_video(target_id uuid) returns void
language plpgsql security definer
set search_path=pg_catalog,public
as $$ begin
  perform 1 from public.videos where id=target_id for update;
end $$;
revoke all on function lock_thumbnail_cleanup_video(uuid) from public;
grant execute on function lock_thumbnail_cleanup_video(uuid) to vid_worker;
create or replace function lock_thumbnail_cleanup_intent(target_id uuid) returns void
language plpgsql security definer
set search_path=pg_catalog,public
as $$ begin
  perform 1 from public.thumbnail_upload_intents where id=target_id for update;
end $$;
revoke all on function lock_thumbnail_cleanup_intent(uuid) from public;
grant execute on function lock_thumbnail_cleanup_intent(uuid) to vid_worker;

grant select,insert,update,delete on object_cleanup_outbox to vid_app;
alter table object_cleanup_outbox enable row level security;
drop policy if exists tenant_isolation on object_cleanup_outbox;
drop policy if exists worker_cleanup on object_cleanup_outbox;
drop policy if exists worker_cleanup on thumbnail_upload_intents;
drop policy if exists worker_thumbnail_read on videos;
create policy tenant_isolation on object_cleanup_outbox for all to vid_app
 using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
create policy worker_cleanup on object_cleanup_outbox for all to vid_worker using(true) with check(true);
create policy worker_cleanup on thumbnail_upload_intents for all to vid_worker using(true) with check(true);
create policy worker_thumbnail_read on videos for select to vid_worker using(true);