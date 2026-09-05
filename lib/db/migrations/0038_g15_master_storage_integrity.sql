-- Quarantine duplicate outstanding work before widening the uniqueness rule to
-- include retryable failures.
with ranked as (
  select id,
         row_number() over (
           partition by video_id
           order by case state
             when 'processing' then 0
             when 'queued' then 1
             when 'dispatching' then 2
             when 'pending' then 3
             else 4
           end,
           created_at,
           id
         ) as rank
  from master_storage_operations
  where state in ('pending', 'dispatching', 'queued', 'processing')
     or (state = 'failed' and retryable = true)
)
update master_storage_operations as operation
set state = 'reconciliation_required',
    retryable = false,
    retry_after_at = null,
    claim_token = null,
    claimed_at = null,
    completed_at = coalesce(operation.completed_at, now()),
    diagnostic_code = 'duplicate_outstanding_operation'
from ranked
where ranked.id = operation.id
  and ranked.rank > 1;

-- A dispatch/processing state without a complete claim cannot safely identify
-- an owning worker. Retry below the cap; quarantine exhausted work.
update master_storage_operations
set state = case when attempts < 8 then 'failed'::master_storage_operation_state else 'reconciliation_required'::master_storage_operation_state end,
    retryable = attempts < 8,
    retry_after_at = case when attempts < 8 then now() else null end,
    claim_token = null,
    claimed_at = null,
    completed_at = case when attempts < 8 then null else coalesce(completed_at, now()) end,
    diagnostic_code = case when attempts < 8 then 'invalid_or_lost_claim' else 'invalid_claim_attempts_exhausted' end
where state in ('dispatching', 'processing')
  and (claim_token is null or claimed_at is null);

update master_storage_operations
set claim_token = null,
    claimed_at = null
where state not in ('dispatching', 'processing')
  and (claim_token is not null or claimed_at is not null);

update master_storage_operations
set retryable = true,
    completed_at = null
where state in ('pending', 'dispatching', 'queued', 'processing')
  and (retryable = false or completed_at is not null);

update master_storage_operations
set retryable = false,
    retry_after_at = null,
    completed_at = coalesce(completed_at, now())
where state in ('completed', 'reconciliation_required', 'cancelled')
  and (retryable = true or retry_after_at is not null or completed_at is null);

update master_storage_operations
set retryable = false,
    retry_after_at = null,
    completed_at = coalesce(completed_at, now()),
    diagnostic_code = coalesce(diagnostic_code, 'attempts_exhausted')
where state = 'failed'
  and attempts >= 8
  and retryable = true;

update master_storage_operations
set completed_at = null
where state = 'failed'
  and retryable = true
  and completed_at is not null;

update master_storage_operations
set completed_at = coalesce(completed_at, now()),
    retry_after_at = null
where state = 'failed'
  and retryable = false
  and (completed_at is null or retry_after_at is not null);

update master_storage_operations
set retry_after_at = null
where retry_after_at is not null
  and not (state = 'failed' and retryable = true);

drop index if exists master_storage_operations_one_active_video_idx;
create unique index master_storage_operations_one_outstanding_video_idx
  on master_storage_operations(video_id)
  where state in ('pending', 'dispatching', 'queued', 'processing')
     or (state = 'failed' and retryable = true);

alter table master_storage_operations
  add constraint master_storage_operations_idempotency_key_check
    check (idempotency_key ~ '^[a-f0-9]{64}$') not valid,
  add constraint master_storage_operations_claim_state_check
    check (
      (
        state in ('dispatching', 'processing')
        and claim_token is not null
        and claimed_at is not null
      ) or (
        state not in ('dispatching', 'processing')
        and claim_token is null
        and claimed_at is null
      )
    ) not valid,
  add constraint master_storage_operations_retry_state_check
    check (
      (state in ('pending', 'dispatching', 'queued', 'processing') and retryable = true)
      or (state in ('completed', 'reconciliation_required', 'cancelled') and retryable = false)
      or state = 'failed'
    ) not valid,
  add constraint master_storage_operations_completed_state_check
    check (
      (completed_at is not null) = (
        state in ('completed', 'reconciliation_required', 'cancelled')
        or (state = 'failed' and retryable = false)
      )
    ) not valid,
  add constraint master_storage_operations_retry_after_check
    check (retry_after_at is null or (state = 'failed' and retryable = true)) not valid;

alter table master_storage_operations
  validate constraint master_storage_operations_idempotency_key_check,
  validate constraint master_storage_operations_claim_state_check,
  validate constraint master_storage_operations_retry_state_check,
  validate constraint master_storage_operations_completed_state_check,
  validate constraint master_storage_operations_retry_after_check;