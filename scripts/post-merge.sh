#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Shared development databases may already contain the pre-ledger Step 15 schema.
# Adoption validates the catalog, records only reviewed migration checksums, and is
# serialized by the migration runner's session advisory lock.
pnpm --filter @workspace/db exec node --experimental-strip-types ./scripts/migrate.ts adopt-baseline --confirm
pnpm --filter @workspace/db verify-schema
