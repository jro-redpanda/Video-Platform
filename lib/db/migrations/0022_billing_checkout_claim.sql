-- A checkout session is an organization-scoped, durable external-effect claim.
-- It intentionally does not alter the paid-plan projection for grandfathered orgs.
alter table organization_billing
  add column pending_checkout_session_id text,
  add column pending_checkout_plan_id uuid references plans(id) on delete restrict,
  add column pending_checkout_price_id text,
  add column pending_checkout_interval billing_interval,
  add column pending_checkout_expires_at timestamptz,
  add column pending_checkout_operation_id uuid references billing_operations(id) on delete set null;

create unique index organization_billing_pending_checkout_session_idx
  on organization_billing(pending_checkout_session_id)
  where pending_checkout_session_id is not null;
create index organization_billing_pending_checkout_expiry_idx
  on organization_billing(pending_checkout_expires_at)
  where pending_checkout_session_id is not null;