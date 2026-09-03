# Audit operations

`audit_logs` is tenant-scoped and append-only for `vid_app`: the runtime role has
only `SELECT` and `INSERT`. Database owners retain maintenance access. Do not
grant `UPDATE`, `DELETE`, or `TRUNCATE` to the application role; audit correction
is a new event, never an edit.

Write events with `writeAuditEvent` in the same transaction as the change being
recorded. Actions and categories are lower-case machine values, while the subject
label is the display value. The helper accepts user, system, job, and webhook
actors and removes credentials, signed URLs, webhook payloads, cookies, tokens,
and passwords from state and metadata before it reaches the database.

`GET /audit-events` is protected by `audit.read`. Its HMAC cursor is bound to the
tenant, normalized filters, fixed snapshot anchor, and a 15-minute expiry. Cursor
errors must be treated as client errors; clients should restart from page one.
`GET /audit-events/export` requires `audit.export`, defaults to the last 30 days,
allows at most 90 days, and caps output at 10,000 rows. Check
`X-Audit-Export-Truncated`; CSV cells are quoted and formula-prefixed cells are
neutralized.

Current instrumentation gap: existing mutation call sites still use legacy direct
`auditLogsTable` inserts. They receive safe defaults from migration 0027, but do
not yet supply structured before/after state, request IDs, or the shared
sanitizer. New and migrated call sites should use `writeAuditEvent`.