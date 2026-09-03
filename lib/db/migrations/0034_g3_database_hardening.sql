-- G3 least-privilege, tenant-policy, and worker-boundary hardening.
-- Existing migrations are immutable, so this migration replaces the baseline's
-- blanket runtime grants with an explicit manifest.

alter role vid_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role vid_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

revoke create on schema public from public;
grant usage on schema public to vid_app, vid_worker;

revoke all privileges on all tables in schema public from vid_app, vid_worker;
revoke all privileges on all sequences in schema public from vid_app, vid_worker;
alter default privileges in schema public revoke all privileges on tables from vid_app, vid_worker;
alter default privileges in schema public revoke all privileges on sequences from vid_app, vid_worker;
alter default privileges in schema public revoke execute on functions from public;

-- Global catalogs and tenant identities are read-only to tenant transactions.
grant select on plans, users, provider_accounts to vid_app;
grant select on schema_migrations to vid_app;
grant select, insert on permissions to vid_app;
grant select, insert, update on organizations to vid_app;

grant select, insert, update on
  organization_customization,
  memberships,
  analytics_playback_sessions,
  organization_billing,
  billing_operations,
  billing_event_receipts,
  custom_domain_verification_windows,
  master_storage_operations,
  webhook_events,
  embed_generation_outbox,
  object_cleanup_outbox
to vid_app;
grant select, insert on video_analytics_rollups, playback_events to vid_app;
grant select, insert, update on onboarding_provisioning_intents to vid_app;

grant select, insert, update, delete on
  permission_groups,
  invitations,
  folders,
  videos,
  video_embeds,
  provider_tenant_spaces,
  thumbnail_upload_intents,
  analytics_dirty_days,
  analytics_rate_windows,
  custom_domains
to vid_app;

grant select, insert, delete on group_permissions to vid_app;
grant select on organization_entitlement_overrides to vid_app;
grant select, insert on audit_logs to vid_app;

-- Thumbnail cleanup retains its narrow column-level mutation rights.
grant select, insert, delete on object_cleanup_outbox to vid_worker;
grant update(attempts, next_attempt_at, last_error, completed_at, quarantined_at, updated_at)
  on object_cleanup_outbox to vid_worker;
grant select, delete on thumbnail_upload_intents to vid_worker;

-- Cross-tenant maintenance runs only after SET LOCAL ROLE vid_worker and uses a
-- purpose-specific transaction setting as a second condition.
grant select, update on onboarding_provisioning_intents, organizations to vid_worker;
grant select, insert, update on organization_customization to vid_worker;
grant select, update on custom_domains, custom_domain_verification_windows to vid_worker;
grant select, update on master_storage_operations, videos to vid_worker;
grant select, update on provider_accounts to vid_worker;
grant select, insert, update, delete on provider_tenant_spaces to vid_worker;
grant select, insert on permissions, permission_groups, group_permissions to vid_worker;
grant select, insert, update on video_embeds to vid_worker;
grant select, update on embed_generation_outbox to vid_worker;
grant select, update, delete on analytics_dirty_days to vid_worker;
grant select, delete on playback_events, analytics_rate_windows,
  analytics_playback_sessions to vid_worker;
grant select, insert, update on video_analytics_rollups to vid_worker;
grant select on plans to vid_worker;
grant select, update on organization_billing to vid_worker;
grant insert on audit_logs to vid_worker;

-- Direct tenant rows that were previously reachable through broad grants.
alter table organizations enable row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations for all to vid_app
  using (id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.organization_id', true), '')::uuid);
drop policy if exists onboarding_self_read on organizations;
create policy onboarding_self_read on organizations for select to vid_app
  using (exists (
    select 1 from memberships m
    where m.organization_id = organizations.id
      and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  ));

alter table users enable row level security;
drop policy if exists tenant_isolation on users;
create policy tenant_isolation on users for select to vid_app
  using (exists (
    select 1 from memberships m
    where m.user_id = users.id
      and m.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ));

alter table provider_accounts enable row level security;
drop policy if exists tenant_isolation on provider_accounts;
create policy tenant_isolation on provider_accounts for select to vid_app
  using (exists (
    select 1 from provider_tenant_spaces s
    where s.provider_account_id = provider_accounts.id
      and s.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ));
drop policy if exists worker_read on provider_accounts;
create policy worker_read on provider_accounts for select to vid_worker
  using (
    current_user = 'vid_worker'
    and (
      current_setting('app.onboarding_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
    )
  );
drop policy if exists worker_update on provider_accounts;
create policy worker_update on provider_accounts for update to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');

alter table permissions enable row level security;
drop policy if exists app_read on permissions;
create policy app_read on permissions for select to vid_app using (true);
drop policy if exists app_catalog_insert on permissions;
create policy app_catalog_insert on permissions for insert to vid_app
  with check (key = any(array[
    'workspace.manage','videos.read','videos.create','videos.update','videos.delete',
    'members.manage','analytics.read','audit.read','audit.export'
  ]));
drop policy if exists onboarding_worker_read on permissions;
create policy onboarding_worker_read on permissions for select to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');
drop policy if exists onboarding_worker_insert on permissions;
create policy onboarding_worker_insert on permissions for insert to vid_worker
  with check (
    current_user = 'vid_worker'
    and current_setting('app.onboarding_worker', true) = 'on'
    and key = any(array[
      'workspace.manage','videos.read','videos.create','videos.update','videos.delete',
      'members.manage','analytics.read','audit.read','audit.export'
    ])
  );

alter table plans enable row level security;
drop policy if exists app_read on plans;
create policy app_read on plans for select to vid_app using (true);
drop policy if exists billing_worker_read on plans;
create policy billing_worker_read on plans for select to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.billing_worker', true) = 'on');

alter table webhook_events enable row level security;
drop policy if exists tenant_isolation on webhook_events;
create policy tenant_isolation on webhook_events for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

alter table video_embeds enable row level security;
drop policy if exists tenant_isolation on video_embeds;
create policy tenant_isolation on video_embeds for all to vid_app
  using (exists (
    select 1 from videos v
    where v.id = video_embeds.video_id
      and v.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ))
  with check (exists (
    select 1 from videos v
    where v.id = video_embeds.video_id
      and v.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ));

alter table embed_generation_outbox enable row level security;
drop policy if exists tenant_isolation on embed_generation_outbox;
create policy tenant_isolation on embed_generation_outbox for all to vid_app
  using (exists (
    select 1 from videos v
    where v.id = embed_generation_outbox.video_id
      and v.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ))
  with check (exists (
    select 1 from videos v
    where v.id = embed_generation_outbox.video_id
      and v.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  ));
drop policy if exists embed_worker_access on video_embeds;
create policy embed_worker_access on video_embeds for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.embed_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.embed_worker', true) = 'on');
drop policy if exists embed_worker_access on embed_generation_outbox;
create policy embed_worker_access on embed_generation_outbox for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.embed_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.embed_worker', true) = 'on');

-- Remove forgeable worker bypasses from vid_app policies.
drop policy if exists tenant_isolation on onboarding_provisioning_intents;
create policy tenant_isolation on onboarding_provisioning_intents for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
drop policy if exists onboarding_self_read on onboarding_provisioning_intents;
create policy onboarding_self_read on onboarding_provisioning_intents for select to vid_app
  using (requested_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
drop policy if exists onboarding_worker_access on onboarding_provisioning_intents;
create policy onboarding_worker_access on onboarding_provisioning_intents for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');

drop policy if exists onboarding_worker_access on provider_tenant_spaces;
create policy onboarding_worker_access on provider_tenant_spaces for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');
drop policy if exists upload_expiry_worker_access on provider_tenant_spaces;
create policy upload_expiry_worker_access on provider_tenant_spaces for select to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.upload_expiry_worker', true) = 'on');
drop policy if exists onboarding_worker_access on permission_groups;
create policy onboarding_worker_access on permission_groups for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');
drop policy if exists onboarding_worker_access on group_permissions;
create policy onboarding_worker_access on group_permissions for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.onboarding_worker', true) = 'on');

drop policy if exists tenant_isolation on custom_domains;
create policy tenant_isolation on custom_domains for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
drop policy if exists authenticated_member_read on custom_domains;
create policy authenticated_member_read on custom_domains for select to vid_app
  using (exists (
    select 1 from memberships m
    where m.organization_id = custom_domains.organization_id
      and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      and m.status = 'active'
  ));
drop policy if exists custom_domain_worker_access on custom_domains;
create policy custom_domain_worker_access on custom_domains for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.custom_domain_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.custom_domain_worker', true) = 'on');

drop policy if exists tenant_isolation on custom_domain_verification_windows;
create policy tenant_isolation on custom_domain_verification_windows for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
drop policy if exists custom_domain_worker_access on custom_domain_verification_windows;
create policy custom_domain_worker_access on custom_domain_verification_windows for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.custom_domain_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.custom_domain_worker', true) = 'on');

drop policy if exists tenant_isolation on master_storage_operations;
create policy tenant_isolation on master_storage_operations for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
drop policy if exists master_storage_worker_access on master_storage_operations;
create policy master_storage_worker_access on master_storage_operations for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.master_storage_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.master_storage_worker', true) = 'on');

-- Worker policies are permissive, so current_user must be part of every
-- expression: role membership alone must not widen vid_app visibility.
drop policy if exists worker_cleanup on object_cleanup_outbox;
create policy worker_cleanup on object_cleanup_outbox for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.thumbnail_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.thumbnail_worker', true) = 'on');
drop policy if exists worker_cleanup on thumbnail_upload_intents;
create policy worker_cleanup on thumbnail_upload_intents for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.thumbnail_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.thumbnail_worker', true) = 'on');
drop policy if exists worker_thumbnail_read on videos;
drop policy if exists master_storage_worker_access on videos;
drop policy if exists maintenance_worker_access on videos;
drop policy if exists maintenance_worker_read on videos;
create policy maintenance_worker_read on videos for select to vid_worker
  using (
    current_user = 'vid_worker'
    and (
      current_setting('app.thumbnail_worker', true) = 'on'
      or current_setting('app.master_storage_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
      or current_setting('app.embed_worker', true) = 'on'
      or current_setting('app.analytics_worker', true) = 'on'
    )
  );
drop policy if exists maintenance_worker_update on videos;
create policy maintenance_worker_update on videos for update to vid_worker
  using (
    current_user = 'vid_worker'
    and (
      current_setting('app.master_storage_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
    )
  )
  with check (
    current_user = 'vid_worker'
    and (
      current_setting('app.master_storage_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
    )
  );

drop policy if exists onboarding_worker_access on organizations;
create policy onboarding_worker_access on organizations for all to vid_worker
  using (
    current_user = 'vid_worker'
    and (
      current_setting('app.onboarding_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
      or current_setting('app.billing_worker', true) = 'on'
    )
  )
  with check (
    current_user = 'vid_worker'
    and (
      current_setting('app.onboarding_worker', true) = 'on'
      or current_setting('app.upload_expiry_worker', true) = 'on'
      or current_setting('app.billing_worker', true) = 'on'
    )
  );
drop policy if exists custom_domain_worker_access on organization_customization;
create policy custom_domain_worker_access on organization_customization for all to vid_worker
  using (
    current_user = 'vid_worker'
    and (
      current_setting('app.custom_domain_worker', true) = 'on'
      or current_setting('app.onboarding_worker', true) = 'on'
    )
  )
  with check (
    current_user = 'vid_worker'
    and (
      current_setting('app.custom_domain_worker', true) = 'on'
      or current_setting('app.onboarding_worker', true) = 'on'
    )
  );

drop policy if exists analytics_worker_access on analytics_dirty_days;
create policy analytics_worker_access on analytics_dirty_days for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on');
drop policy if exists analytics_worker_access on playback_events;
create policy analytics_worker_access on playback_events for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on');
drop policy if exists analytics_worker_access on analytics_rate_windows;
create policy analytics_worker_access on analytics_rate_windows for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on');
drop policy if exists analytics_worker_access on analytics_playback_sessions;
create policy analytics_worker_access on analytics_playback_sessions for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on');
drop policy if exists analytics_worker_access on video_analytics_rollups;
create policy analytics_worker_access on video_analytics_rollups for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.analytics_worker', true) = 'on');

drop policy if exists billing_worker_access on organization_billing;
create policy billing_worker_access on organization_billing for all to vid_worker
  using (current_user = 'vid_worker' and current_setting('app.billing_worker', true) = 'on')
  with check (current_user = 'vid_worker' and current_setting('app.billing_worker', true) = 'on');
drop policy if exists maintenance_worker_insert on audit_logs;
create policy maintenance_worker_insert on audit_logs for insert to vid_worker
  with check (
    current_user = 'vid_worker'
    and (
      current_setting('app.onboarding_worker', true) = 'on'
      or current_setting('app.custom_domain_worker', true) = 'on'
      or current_setting('app.master_storage_worker', true) = 'on'
      or current_setting('app.embed_worker', true) = 'on'
      or current_setting('app.billing_worker', true) = 'on'
    )
  );

revoke all on function public.lookup_acceptable_invitation(text, text) from public;
revoke all on function public.lock_thumbnail_cleanup_video(uuid) from public;
revoke all on function public.lock_thumbnail_cleanup_intent(uuid) from public;
grant execute on function public.lookup_acceptable_invitation(text, text) to vid_app;
grant execute on function public.lock_thumbnail_cleanup_video(uuid) to vid_worker;
grant execute on function public.lock_thumbnail_cleanup_intent(uuid) to vid_worker;