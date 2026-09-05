alter table organization_billing
  add column pending_subscription_schedule_id text;

alter table plans
  add column monthly_amount_cents integer,
  add column annual_amount_cents integer;

update plans
set monthly_amount_cents = case code
    when 'starter' then 4900
    when 'growth' then 14900
    when 'scale' then 39900
  end,
  annual_amount_cents = case code
    when 'starter' then 49000
    when 'growth' then 149000
    when 'scale' then 399000
  end
where code in ('starter', 'growth', 'scale');

alter table plans
  add constraint plans_billing_amounts_check
  check (
    (monthly_amount_cents is null and annual_amount_cents is null)
    or (monthly_amount_cents > 0 and annual_amount_cents > 0)
  );

alter table organization_billing
  add constraint organization_billing_pending_subscription_schedule_unique
  unique (pending_subscription_schedule_id);

drop index if exists organization_billing_pending_checkout_session_idx;

alter table organization_billing
  add constraint organization_billing_pending_checkout_session_unique
  unique (pending_checkout_session_id);

alter table billing_event_receipts
  add column stripe_customer_id text,
  add column stripe_subscription_id text,
  add column stripe_checkout_session_id text,
  add column processing_claim uuid,
  add column processing_claimed_at timestamptz,
  add column attempts integer not null default 0;

alter table billing_event_receipts
  add constraint billing_event_receipts_attempts_check
  check (attempts >= 0),
  add constraint billing_event_receipts_processing_state_check
  check (processing_state in (
    'received',
    'processing',
    'binding_pending',
    'failed',
    'processed',
    'ignored',
    'quarantined'
  )),
  add constraint billing_event_receipts_claim_check
  check (
    (processing_state = 'processing' and processing_claim is not null and processing_claimed_at is not null)
    or (processing_state <> 'processing' and processing_claim is null and processing_claimed_at is null)
  );

grant select, insert, update on billing_event_receipts to vid_worker;

drop policy if exists billing_worker_access on billing_event_receipts;
create policy billing_worker_access on billing_event_receipts for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.billing_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.billing_worker', true) = 'on');