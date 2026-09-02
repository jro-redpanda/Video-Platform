-- Preserve exact provider authority separately from the access-policy status.
-- In particular, restricted+canceled may resubscribe while restricted+unpaid may not.
alter table organization_billing
  add column stripe_subscription_status text;

alter table organization_billing
  add constraint organization_billing_stripe_subscription_status_check
  check (
    stripe_subscription_status is null or
    stripe_subscription_status in (
      'incomplete','incomplete_expired','trialing','active',
      'past_due','canceled','unpaid','paused'
    )
  );