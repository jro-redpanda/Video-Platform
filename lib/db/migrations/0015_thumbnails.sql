-- Step 15 is additive.  Existing objects are adopted only if their catalog shape is compatible.
do $$ begin
  if to_regclass('public.videos') is null then raise exception '0015 requires public.videos'; end if;
  if exists (select 1 from pg_attribute where attrelid='public.videos'::regclass and attname='thumbnail_object_key' and atttypid <> 'text'::regtype) then raise exception 'incompatible videos.thumbnail_object_key'; end if;
  if exists (select 1 from pg_attribute where attrelid='public.videos'::regclass and attname='thumbnail_content_type' and atttypid <> 'text'::regtype) then raise exception 'incompatible videos.thumbnail_content_type'; end if;
  if exists (select 1 from pg_attribute where attrelid='public.videos'::regclass and attname='thumbnail_size_bytes' and atttypid <> 'integer'::regtype) then raise exception 'incompatible videos.thumbnail_size_bytes'; end if;
end $$;
alter table videos add column if not exists thumbnail_object_key text;
alter table videos add column if not exists thumbnail_content_type text;
alter table videos add column if not exists thumbnail_size_bytes integer;
do $$ begin
 if not exists (select 1 from pg_constraint where conrelid='public.videos'::regclass and conname='videos_thumbnail_metadata_check') then
  alter table videos add constraint videos_thumbnail_metadata_check check ((thumbnail_object_key is null and thumbnail_content_type is null and thumbnail_size_bytes is null) or (thumbnail_object_key is not null and thumbnail_content_type in ('image/jpeg','image/png','image/webp') and thumbnail_size_bytes between 1 and 10485760));
 elsif not exists (select 1 from pg_constraint where conrelid='public.videos'::regclass and conname='videos_thumbnail_metadata_check' and contype='c' and pg_get_constraintdef(oid) like '%thumbnail_object_key%thumbnail_content_type%thumbnail_size_bytes%') then raise exception 'incompatible videos_thumbnail_metadata_check'; end if;
end $$;
create table if not exists thumbnail_upload_intents (id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, video_id uuid not null references videos(id) on delete cascade, object_key text not null, declared_content_type text not null, declared_size_bytes integer not null, expires_at timestamptz not null, finalized_at timestamptz, created_at timestamptz not null default now(), constraint thumbnail_upload_intents_size_check check(declared_size_bytes between 1 and 10485760), constraint thumbnail_upload_intents_type_check check(declared_content_type in ('image/jpeg','image/png','image/webp')), constraint thumbnail_upload_intents_key_check check(object_key like 'thumbnails/%' and object_key not like '%..%'));
create unique index if not exists thumbnail_upload_intents_object_key_idx on thumbnail_upload_intents(object_key);
create index if not exists thumbnail_upload_intents_video_idx on thumbnail_upload_intents(organization_id,video_id);
create index if not exists thumbnail_upload_intents_expiry_idx on thumbnail_upload_intents(finalized_at,expires_at);
create table if not exists object_cleanup_outbox (id uuid primary key default gen_random_uuid(), object_key text not null, attempts integer not null default 0, next_attempt_at timestamptz not null default now(), last_error text, completed_at timestamptz, quarantined_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index if not exists object_cleanup_outbox_object_key_idx on object_cleanup_outbox(object_key);
create index if not exists object_cleanup_outbox_pending_idx on object_cleanup_outbox(completed_at,next_attempt_at);
grant select,insert,update,delete on thumbnail_upload_intents,object_cleanup_outbox to vid_app;
alter table thumbnail_upload_intents enable row level security;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='thumbnail_upload_intents' and policyname='tenant_isolation') then create policy tenant_isolation on thumbnail_upload_intents for all to vid_app using (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid) with check (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid); end if; end $$;