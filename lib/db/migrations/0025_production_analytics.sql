-- Provider-neutral, tenant-isolated playback analytics.
alter table playback_events
  add column event_id uuid,
  add column embed_id uuid,
  add column received_at timestamptz not null default now(),
  add column duration_seconds double precision,
  add column error_category text;

update playback_events set event_id=id, embed_id=video_id where event_id is null or embed_id is null;
alter table playback_events alter column event_id set not null, alter column embed_id set not null;
alter table playback_events
  add constraint playback_events_embed_fk foreign key(embed_id) references video_embeds(video_id) on delete cascade,
  add constraint playback_events_type_check check(event_type in ('load','play','progress','pause','ended','error')),
  add constraint playback_events_position_check check(position_seconds between 0 and 86400),
  add constraint playback_events_duration_check check(duration_seconds is null or duration_seconds between 0 and 86400),
  add constraint playback_events_error_check check(error_category is null or (event_type='error' and error_category in ('network','media','decode','source','unknown')));
create unique index playback_events_org_event_idx on playback_events(organization_id,event_id);
create index playback_events_org_video_day_idx on playback_events(organization_id,video_id,((occurred_at at time zone 'UTC')::date));
create index playback_events_org_video_session_idx on playback_events(organization_id,video_id,session_id,occurred_at,event_id);
create index playback_events_retention_idx on playback_events(received_at);

alter table video_analytics_rollups alter column day type date using day::date;
alter table video_analytics_rollups
  add column unique_sessions integer not null default 0,
  add column completions integer not null default 0;
-- Historical fixture completion rates were percentages; normalize to a ratio.
update video_analytics_rollups set completion_rate=completion_rate/100 where completion_rate > 1;
alter table video_analytics_rollups
  add constraint video_rollups_counts_check check(plays >= 0 and unique_sessions >= 0 and watch_time_seconds >= 0 and completions >= 0 and completion_rate between 0 and 1);
drop index video_rollups_video_day_idx;
create unique index video_rollups_org_video_day_idx on video_analytics_rollups(organization_id,video_id,day);
create index video_rollups_org_day_idx on video_analytics_rollups(organization_id,day);

create table analytics_dirty_days (
  organization_id uuid not null references organizations(id) on delete cascade,
  video_id uuid not null references videos(id) on delete cascade,
  day date not null,
  version bigint not null default 1,
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  claimed_at timestamptz,
  primary key(organization_id,video_id,day),
  constraint analytics_dirty_days_version_check check(version > 0),
  constraint analytics_dirty_days_attempts_check check(attempts >= 0)
);
create index analytics_dirty_days_available_idx on analytics_dirty_days(available_at,claimed_at);

create table analytics_rate_windows (
  organization_id uuid not null references organizations(id) on delete cascade,
  dimension_type text not null check(dimension_type in ('ip','grant_video')),
  dimension_hash text not null check(char_length(dimension_hash)=64),
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  event_count integer not null default 0,
  expires_at timestamptz not null,
  primary key(organization_id,dimension_type,dimension_hash,window_started_at),
  constraint analytics_rate_windows_counts_check check(request_count >= 0 and event_count >= 0)
);
create index analytics_rate_windows_expiry_idx on analytics_rate_windows(expires_at);

grant select,insert,update,delete on analytics_dirty_days,analytics_rate_windows to vid_app;
alter table analytics_dirty_days enable row level security;
create policy tenant_isolation on analytics_dirty_days for all to vid_app
  using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
alter table analytics_rate_windows enable row level security;
create policy tenant_isolation on analytics_rate_windows for all to vid_app
  using (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  with check (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);