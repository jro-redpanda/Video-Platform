create table analytics_playback_sessions (
  organization_id uuid not null references organizations(id) on delete cascade,
  video_id uuid not null references videos(id) on delete cascade,
  embed_id uuid not null references video_embeds(video_id) on delete cascade,
  client_session_id uuid not null,
  grant_jti_hash text not null check(char_length(grant_jti_hash)=64),
  first_received_at timestamptz not null,
  load_occurred_at timestamptz not null,
  last_received_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(organization_id,video_id,client_session_id),
  unique(organization_id,grant_jti_hash),
  constraint analytics_playback_sessions_times_check check(last_received_at >= first_received_at and expires_at > first_received_at)
);
create index analytics_playback_sessions_expiry_idx on analytics_playback_sessions(expires_at);
create index analytics_playback_sessions_org_video_idx on analytics_playback_sessions(organization_id,video_id,client_session_id);
grant select,insert,update,delete on analytics_playback_sessions to vid_app;
alter table analytics_playback_sessions enable row level security;
create policy tenant_isolation on analytics_playback_sessions for all to vid_app
  using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);