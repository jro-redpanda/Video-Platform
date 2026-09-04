-- G8 durable frozen projections for mutation-stable video-library cursors.

create table video_library_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  scope_hash text not null,
  total integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint video_library_snapshots_total_check check (total >= 0),
  constraint video_library_snapshots_expiry_check check (expires_at > created_at)
);
create unique index video_library_snapshots_id_org_idx
  on video_library_snapshots(id, organization_id);
create index video_library_snapshots_org_expiry_idx
  on video_library_snapshots(organization_id, expires_at);

create table video_library_snapshot_items (
  snapshot_id uuid not null,
  organization_id uuid not null,
  position integer not null,
  payload jsonb not null,
  constraint video_library_snapshot_items_pk primary key(snapshot_id, position),
  constraint video_library_snapshot_items_snapshot_org_fk
    foreign key(snapshot_id, organization_id)
    references video_library_snapshots(id, organization_id) on delete cascade,
  constraint video_library_snapshot_items_position_check check(position >= 0)
);
create index video_library_snapshot_items_org_snapshot_idx
  on video_library_snapshot_items(organization_id, snapshot_id, position);

grant select, insert, delete on
  video_library_snapshots,
  video_library_snapshot_items
to vid_app;

alter table video_library_snapshots enable row level security;
create policy tenant_isolation on video_library_snapshots for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

alter table video_library_snapshot_items enable row level security;
create policy tenant_isolation on video_library_snapshot_items for all to vid_app
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);