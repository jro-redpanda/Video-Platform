# Database migration contract

`lib/db/migrations` is the only release contract for the application schema.
Files are immutable, lexicographically ordered SQL and are tracked by raw-byte
SHA-256 in `public.schema_migrations`. Do not use Drizzle push in a deployment.

## Clean database

Use a database role allowed to create the application schema and the `vid_app`
NOLOGIN role, set `DATABASE_URL`, then run:

```sh
pnpm --filter @workspace/db migrate
pnpm --filter @workspace/db verify-schema
```

The runner holds a session advisory lock and commits each migration separately;
it is safe for multiple deploy processes to invoke it, although deployment
should still migrate before starting application replicas.

## Existing database adoption

For the reviewed pre-ledger schema (including a database already pushed through
Step 15), inspect its catalog first, then explicitly acknowledge adoption:

```sh
pnpm --filter @workspace/db exec node --experimental-strip-types \
  scripts/migrate.ts adopt-baseline --confirm
pnpm --filter @workspace/db verify-schema
```

Adoption validates the known application table manifest, writes only the
baseline ledger row without running baseline DDL, then validates/applies the
additive Step 15 SQL. It never creates a Drizzle journal and refuses an unknown
or incomplete manifest. Back up and investigate rather than editing a recorded
checksum.

## Development and deployment

`scripts/post-merge.sh` runs this explicit shared-development adoption flow and
verification under the same advisory-lock protocol. For local schema
experiments only, `prototype:push` exists and rejects `NODE_ENV=production`;
its output must be converted into reviewed forward-only SQL before release.

Deploy migration/verification before API replicas or workers start. Runtime
connections should use the least-privileged `vid_app` role, with
`app.organization_id` set per transaction; schema owners run migrations.
RLS/grants are migration-owned and startup performs no DDL. Corrections are
new forward-only numbered migrations: never rewrite an applied file or use a
destructive drop to repair production data.

The `0020` migration pins pg-boss 12.29.0 construction and upgrade plan
checksums and schema version 39. Every `PgBoss` instance sets `migrate:false`;
only the schema-owning migration connection may construct or upgrade
`vid_jobs`. Runtime roles need DML/execute access to the managed queue objects,
not schema ownership or CREATE privileges.