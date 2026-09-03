create type custom_domain_lifecycle as enum (
  'pending_verification','verifying','verified','failed','suspended','removed','reconciliation_required'
);

create table custom_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  hostname text not null,
  lifecycle_state custom_domain_lifecycle not null default 'pending_verification',
  challenge_name text not null,
  challenge_value text not null,
  retryable boolean not null default true,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 8),
  claim_token uuid,
  claimed_at timestamptz,
  verify_requested_at timestamptz,
  retry_after_at timestamptz,
  last_checked_at timestamptz,
  verified_at timestamptz,
  removed_at timestamptz,
  diagnostic_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_domains_active_fields check (
    (lifecycle_state = 'removed' and removed_at is not null and retryable = false)
    or lifecycle_state <> 'removed'
  )
);
create unique index custom_domains_one_active_org_idx on custom_domains(organization_id)
  where lifecycle_state not in ('removed');
create unique index custom_domains_unique_active_hostname_idx on custom_domains(hostname)
  where lifecycle_state not in ('removed');
create index custom_domains_worker_idx on custom_domains(lifecycle_state,retry_after_at,created_at);
grant select,insert,update,delete on custom_domains to vid_app;
alter table custom_domains enable row level security;
create policy tenant_isolation on custom_domains for all to vid_app using (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.custom_domain_worker', true) = 'on'
) with check (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.custom_domain_worker', true) = 'on'
);

create table custom_domain_verification_windows (
  organization_id uuid primary key references organizations(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts >= 1),
  updated_at timestamptz not null default now()
);
grant select,insert,update,delete on custom_domain_verification_windows to vid_app;
alter table custom_domain_verification_windows enable row level security;
create policy tenant_isolation on custom_domain_verification_windows for all to vid_app using (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.custom_domain_worker', true) = 'on'
) with check (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  or current_setting('app.custom_domain_worker', true) = 'on'
);