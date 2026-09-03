-- Reuse the durable analytics rate-window store for tenant audit exports.
alter table analytics_rate_windows drop constraint analytics_rate_windows_dimension_type_check;
alter table analytics_rate_windows add constraint analytics_rate_windows_dimension_type_check
  check(dimension_type in ('ip','grant_video','audit_export'));