-- Extend the baseline audit table in place: deployed rows remain valid and readable.
alter table audit_logs
  add column actor_kind text not null default 'user',
  add column category text not null default 'general',
  add column before_state jsonb,
  add column after_state jsonb,
  add column request_id text;

alter table audit_logs
  add constraint audit_logs_actor_kind_check check (actor_kind in ('user','system','webhook','job')),
  add constraint audit_logs_category_machine_check check (category ~ '^[a-z][a-z0-9_.-]{0,63}$');

-- The old two-column index is replaced to guarantee a deterministic timeline.
drop index if exists audit_logs_org_time_idx;
create index audit_logs_org_time_idx on audit_logs(organization_id, created_at desc, id desc);
create index audit_logs_org_category_time_idx on audit_logs(organization_id, category, created_at desc, id desc);
create index audit_logs_org_subject_time_idx on audit_logs(organization_id, subject_type, subject_id, created_at desc, id desc);
create index audit_logs_org_actor_time_idx on audit_logs(organization_id, actor_kind, actor_user_id, created_at desc, id desc);

-- The application role can append and inspect tenant rows, never alter history.
revoke update, delete, truncate on audit_logs from vid_app;
grant select, insert on audit_logs to vid_app;