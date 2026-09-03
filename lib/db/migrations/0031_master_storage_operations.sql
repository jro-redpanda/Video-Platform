create type master_storage_operation_kind as enum ('archive','restore');
create type master_storage_operation_state as enum (
  'pending','dispatching','queued','processing','completed','failed','reconciliation_required','cancelled'
);
create unique index videos_id_organization_identity_idx on videos(id,organization_id);
create table master_storage_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  video_id uuid not null references videos(id) on delete cascade,
  requested_by_user_id uuid not null references users(id) on delete restrict,
  operation master_storage_operation_kind not null,
  state master_storage_operation_state not null default 'pending',
  idempotency_key text not null,
  provider_account_id uuid not null,
  provider_tenant_space_id text not null,
  provider_asset_id text not null,
  restore_storage_key text,
  dispatch_generation integer not null default 0 check (dispatch_generation >= 0),
  attempts integer not null default 0 check (attempts between 0 and 8),
  claim_token uuid,
  claimed_at timestamptz,
  dispatched_at timestamptz,
  attempted_at timestamptz,
  retry_after_at timestamptz,
  retryable boolean not null default true,
  diagnostic_code text,
  result_metadata jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint master_storage_operations_restore_key_check check (
    (operation = 'restore') = (restore_storage_key is not null)
  ),
  constraint master_storage_operations_video_organization_fk foreign key (video_id,organization_id)
    references videos(id,organization_id) on delete cascade
);
create unique index master_storage_operations_idempotency_idx on master_storage_operations(idempotency_key);
create unique index master_storage_operations_one_active_video_idx on master_storage_operations(video_id)
  where state in ('pending','dispatching','queued','processing');
create index master_storage_operations_dispatch_idx on master_storage_operations(state,retry_after_at,created_at,dispatch_generation);
create index master_storage_operations_org_video_idx on master_storage_operations(organization_id,video_id,created_at);
-- Operations are state-transition records, not tenant-deletable rows.
grant select,insert,update on master_storage_operations to vid_app;
alter table master_storage_operations enable row level security;
create policy tenant_isolation on master_storage_operations for all to vid_app using (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.master_storage_worker', true) = 'on'
) with check (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.master_storage_worker', true) = 'on'
);