-- Durable customer-create generation prevents a deleted Stripe Customer's
-- historical idempotency result from being replayed forever.
alter table organization_billing
  add column stripe_customer_generation integer not null default 0,
  add column stripe_customer_creation_operation_id uuid references billing_operations(id) on delete set null;

alter table organization_billing
  add constraint organization_billing_customer_generation_check
  check (stripe_customer_generation >= 0);