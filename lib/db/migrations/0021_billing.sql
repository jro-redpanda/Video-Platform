-- Application-owned billing state. Stripe products, prices, events and webhook
-- delivery storage remain exclusively owned by stripe-replit-sync's stripe schema.
-- This controlled public-schema migration intentionally does not fingerprint or
-- mutate provider-owned stripe.* relations.
create type billing_status as enum ('unmanaged','incomplete','active','trialing','past_due','unpaid','canceled','restricted','quarantined');
create type billing_interval as enum ('month','year');
create type billing_operation_state as enum ('claimed','completed','failed');

alter table plans add column description text not null default '';
alter table plans add column active boolean not null default true;
alter table plans add column sort_order integer not null default 0;
alter table plans add column stripe_product_id text;
alter table plans add column stripe_monthly_price_id text;
alter table plans add column stripe_annual_price_id text;
create unique index plans_stripe_product_idx on plans(stripe_product_id);
create unique index plans_stripe_monthly_price_idx on plans(stripe_monthly_price_id);
create unique index plans_stripe_annual_price_idx on plans(stripe_annual_price_id);

create table organization_billing (
  organization_id uuid primary key references organizations(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status billing_status not null default 'unmanaged',
  interval billing_interval,
  current_plan_id uuid references plans(id) on delete restrict,
  period_start timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  pending_plan_id uuid references plans(id) on delete restrict,
  pending_effective_at timestamptz,
  grace_ends_at timestamptz,
  last_stripe_event_id text,
  last_stripe_object_version text,
  last_reconciled_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organization_billing_status_idx on organization_billing(status,updated_at);
create index organization_billing_reconcile_idx on organization_billing(last_reconciled_at);

create table billing_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  operation text not null,
  idempotency_key text not null,
  state billing_operation_state not null default 'claimed',
  request_fingerprint text not null,
  stripe_object_id text,
  result jsonb,
  error_code text,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,operation,idempotency_key)
);
create index billing_operations_claimed_idx on billing_operations(state,claimed_at);

create table billing_event_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  stripe_event_id text not null unique,
  stripe_object_id text,
  stripe_object_version text,
  event_type text not null,
  processing_state text not null default 'received',
  diagnostic_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index billing_event_receipts_pending_idx on billing_event_receipts(processing_state,received_at);

-- Canonical application catalog. Price amounts are deliberately absent: the
-- billing adapter validates amounts/currency/interval against Stripe on read.
insert into plans(code,name,description,active,sort_order,storage_limit_gb,entitlements)
values
  ('starter','Starter','For small video libraries',true,10,100,'{"branding.logo":true,"branding.player_colors":true,"branding.watermark":false,"branding.custom_domain":false,"limits.max_users":5,"limits.max_storage_gb":100,"limits.max_videos":100,"limits.monthly_bandwidth_gb":500,"feature.custom_groups":false,"feature.api_access":false,"feature.captions":true,"feature.analytics_export":false}'::jsonb),
  ('growth','Growth','For growing video teams',true,20,500,'{"branding.logo":true,"branding.player_colors":true,"branding.watermark":true,"branding.custom_domain":false,"limits.max_users":25,"limits.max_storage_gb":500,"limits.max_videos":500,"limits.monthly_bandwidth_gb":2000,"feature.custom_groups":true,"feature.api_access":true,"feature.captions":true,"feature.analytics_export":true}'::jsonb),
  ('scale','Scale','For high-volume video operations',true,30,2000,'{"branding.logo":true,"branding.player_colors":true,"branding.watermark":true,"branding.custom_domain":true,"limits.max_users":100,"limits.max_storage_gb":2000,"limits.max_videos":2500,"limits.monthly_bandwidth_gb":10000,"feature.custom_groups":true,"feature.api_access":true,"feature.captions":true,"feature.analytics_export":true}'::jsonb),
  ('restricted','Restricted','Internal no-create access state',false,999,0,'{"branding.logo":false,"branding.player_colors":false,"branding.watermark":false,"branding.custom_domain":false,"limits.max_users":0,"limits.max_storage_gb":0,"limits.max_videos":0,"limits.monthly_bandwidth_gb":0,"feature.custom_groups":false,"feature.api_access":false,"feature.captions":false,"feature.analytics_export":false}'::jsonb)
on conflict (code) do update set
  name=excluded.name,description=excluded.description,active=excluded.active,
  sort_order=excluded.sort_order,storage_limit_gb=excluded.storage_limit_gb,
  entitlements=excluded.entitlements;

grant select,insert,update,delete on organization_billing,billing_operations,billing_event_receipts to vid_app;
alter table organization_billing enable row level security;
alter table billing_operations enable row level security;
alter table billing_event_receipts enable row level security;
create policy tenant_isolation on organization_billing for all to vid_app using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid) with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
create policy tenant_isolation on billing_operations for all to vid_app using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid) with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
create policy tenant_isolation on billing_event_receipts for all to vid_app using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid) with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);