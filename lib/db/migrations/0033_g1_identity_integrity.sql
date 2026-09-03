-- G1 identity lifecycle and tenant-integrity hardening.  Existing cross-tenant
-- references are rejected rather than guessed or reassigned.
alter table permission_groups add column if not exists system_key text;
alter table invitations add column if not exists revoked_at timestamptz;
alter table invitations add column if not exists delivered_at timestamptz;
alter table invitations add column if not exists accepted_by_user_id uuid references users(id);

update permission_groups set system_key = case name
  when 'Owners' then 'owners' when 'Editors' then 'editors' when 'Viewers' then 'viewers' end
where system_key is null and (
  (name = 'Owners' and description = 'Full workspace access') or
  (name = 'Editors' and description = 'Create and manage videos') or
  (name = 'Viewers' and description = 'View videos and analytics')
);
alter table permission_groups add constraint permission_groups_system_key_check
  check (system_key is null or system_key in ('owners', 'editors', 'viewers'));
create unique index if not exists permission_groups_org_system_key_idx
  on permission_groups(organization_id, system_key) where system_key is not null;

-- Legacy pending records created before delivery tracking cannot be redeemed.
update invitations set revoked_at = now()
where accepted_at is null and (delivered_at is null or token_hash is null or token_hash = '');

do $$ begin
  if exists (
    select 1 from memberships m join permission_groups g on g.id = m.group_id
    where m.organization_id <> g.organization_id
  ) or exists (
    select 1 from invitations i join permission_groups g on g.id = i.group_id
    where i.organization_id <> g.organization_id
  ) then
    raise exception 'cross-organization membership or invitation group references require manual remediation';
  end if;
end $$;

create unique index if not exists permission_groups_org_id_idx on permission_groups(organization_id, id);
alter table memberships drop constraint if exists memberships_group_id_permission_groups_id_fk;
alter table invitations drop constraint if exists invitations_group_id_permission_groups_id_fk;
alter table memberships add constraint memberships_org_group_fk
  foreign key (organization_id, group_id) references permission_groups(organization_id, id);
alter table invitations add constraint invitations_org_group_fk
  foreign key (organization_id, group_id) references permission_groups(organization_id, id);
create unique index if not exists invitations_pending_org_email_idx
  on invitations(organization_id, lower(email)) where accepted_at is null and revoked_at is null;

create or replace function public.lookup_acceptable_invitation(
  p_token_hash text,
  p_normalized_email text
)
returns table(invitation_id uuid, organization_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select i.id, i.organization_id
  from public.invitations i
  join public.organizations o
    on o.id = i.organization_id
   and o.status = 'active'
  join public.permission_groups g
    on g.id = i.group_id
   and g.organization_id = i.organization_id
  where i.token_hash = p_token_hash
    and lower(i.email) = p_normalized_email
    and i.delivered_at is not null
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > now()
  limit 1
$$;
revoke all on function public.lookup_acceptable_invitation(text, text) from public;
grant execute on function public.lookup_acceptable_invitation(text, text) to vid_app;

alter table group_permissions enable row level security;
drop policy if exists tenant_isolation on group_permissions;
create policy tenant_isolation on group_permissions for all to vid_app
  using (exists (select 1 from permission_groups g where g.id = group_permissions.group_id
    and g.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid))
  with check (exists (select 1 from permission_groups g where g.id = group_permissions.group_id
    and g.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid));