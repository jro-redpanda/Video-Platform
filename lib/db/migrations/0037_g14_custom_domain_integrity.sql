-- Normalize retained lifecycle rows before tightening the state machine.
update custom_domains
set challenge_value = 'revoked',
    retryable = false,
    claim_token = null,
    claimed_at = null
where lifecycle_state = 'removed';

update custom_domains
set removed_at = null
where lifecycle_state <> 'removed'
  and removed_at is not null;

update custom_domains
set verified_at = null
where lifecycle_state in ('pending_verification', 'verifying', 'failed', 'suspended')
  and verified_at is not null;

update custom_domains
set claim_token = null,
    claimed_at = null
where lifecycle_state <> 'verifying'
  and (claim_token is not null or claimed_at is not null);

update custom_domains
set lifecycle_state = 'reconciliation_required',
    retryable = false,
    claim_token = null,
    claimed_at = null,
    diagnostic_code = 'invalid_verification_claim'
where lifecycle_state = 'verifying'
  and (claim_token is null or claimed_at is null);

update custom_domains
set lifecycle_state = 'reconciliation_required',
    retryable = false,
    diagnostic_code = 'missing_verified_timestamp'
where lifecycle_state = 'verified'
  and verified_at is null;

update custom_domains
set retryable = false
where lifecycle_state in ('verified', 'suspended', 'removed', 'reconciliation_required')
  and retryable = true;

update custom_domains
set retryable = true
where lifecycle_state in ('pending_verification', 'verifying')
  and retryable = false;

update organization_customization as customization
set custom_domain_verified = false
from custom_domains as domain
where domain.organization_id = customization.organization_id
  and domain.lifecycle_state = 'reconciliation_required'
  and customization.custom_domain = domain.hostname
  and customization.custom_domain_verified = true;

update organization_customization as customization
set custom_domain = null,
    custom_domain_verified = false
from custom_domains as removed
where removed.organization_id = customization.organization_id
  and removed.lifecycle_state = 'removed'
  and customization.custom_domain = removed.hostname
  and not exists (
    select 1
    from custom_domains as active
    where active.organization_id = removed.organization_id
      and active.hostname = removed.hostname
      and active.lifecycle_state <> 'removed'
  );

alter table custom_domains
  drop constraint if exists custom_domains_active_fields;

alter table custom_domains
  add constraint custom_domains_removed_fields check (
    (
      lifecycle_state = 'removed'
      and removed_at is not null
      and retryable = false
      and challenge_value = 'revoked'
    ) or (
      lifecycle_state <> 'removed'
      and removed_at is null
      and challenge_value <> 'revoked'
    )
  ),
  add constraint custom_domains_claim_fields check (
    (
      lifecycle_state = 'verifying'
      and claim_token is not null
      and claimed_at is not null
    ) or (
      lifecycle_state <> 'verifying'
      and claim_token is null
      and claimed_at is null
    )
  ),
  add constraint custom_domains_verified_fields check (
    (
      lifecycle_state = 'verified'
      and verified_at is not null
      and retryable = false
    )
    or (
      lifecycle_state in ('pending_verification', 'verifying', 'failed', 'suspended')
      and verified_at is null
    )
    or lifecycle_state in ('removed', 'reconciliation_required')
  ),
  add constraint custom_domains_retry_state check (
    (
      lifecycle_state in ('pending_verification', 'verifying')
      and retryable = true
    )
    or (
      lifecycle_state in ('verified', 'suspended', 'removed', 'reconciliation_required')
      and retryable = false
    )
    or lifecycle_state = 'failed'
  );