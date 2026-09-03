create type onboarding_intent_state as enum (
  'pending','dispatching','queued','processing','unavailable','failed',
  'reconciliation_required','completed'
);

create table onboarding_provisioning_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by_user_id uuid not null references users(id) on delete restrict,
  state onboarding_intent_state not null default 'pending',
  retryable boolean not null default true,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 20),
  diagnostic_code text,
  dispatch_claim uuid,
  claimed_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_intents_terminal_check check (
    (state = 'completed' and completed_at is not null and retryable = false)
    or state <> 'completed'
  )
);
create unique index onboarding_intents_org_idx on onboarding_provisioning_intents(organization_id);
create index onboarding_intents_dispatch_idx on onboarding_provisioning_intents(state,created_at);
create index onboarding_intents_user_idx on onboarding_provisioning_intents(requested_by_user_id);

grant select,insert,update,delete on onboarding_provisioning_intents to vid_app;
alter table onboarding_provisioning_intents enable row level security;
create policy tenant_isolation on onboarding_provisioning_intents for all to vid_app
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or requested_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    or current_setting('app.onboarding_worker', true) = 'on'
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or requested_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    or current_setting('app.onboarding_worker', true) = 'on'
  );

-- Pre-tenant sessions may discover only their own memberships. Existing tenant
-- policy remains authoritative for all writes and all other users.
create policy onboarding_self_membership_read on memberships for select to vid_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);