# Stripe billing operations

## Environment separation

Development must use the connected Stripe **test** account (`sk_test_`). The catalog reconciler refuses an unrecognized key and exits before any write for `sk_live_`. Live catalog setup is a separate production-readiness operation and must never be copied from database rows.

Stripe credentials are fetched on every operation through the Replit connector. They must not be stored, logged, or added to environment files. Startup requires `DATABASE_URL`, `REPLIT_CONNECTORS_HOSTNAME`, Replit workload identity, and `REPLIT_DOMAINS`.

## Startup and webhook

Application public-schema migrations run through `@workspace/db`. StripeSync then runs its own migrations, constructs the sync client, finds or creates the managed webhook at `/api/stripe/webhook`, and performs backfill in that order. StripeSync exclusively owns `stripe.*`; application migrations and catalog fingerprints intentionally exclude it.

The webhook route is registered with `express.raw` before JSON parsing. It only checks signature presence and delegates signature validation/ingestion to StripeSync. Confirm the managed endpoint URL and delivery health in each environment after a domain change.

## Catalog

Run:

```sh
pnpm --filter @workspace/scripts stripe:seed
```

The command is idempotent, test-mode only, uses stable metadata and idempotency keys, requires exactly three active managed products and six recurring USD prices, transactionally records relationship IDs, then runs StripeSync backfill. A duplicate or amount/interval conflict stops reconciliation for operator review rather than silently selecting a product.

## Reconciliation and incidents

PgBoss reconciles active and at-risk subscriptions every five minutes. Workspace managers may trigger bounded repair through `POST /api/billing/reconcile`. Reconciliation retrieves the authoritative subscription from Stripe and quarantines unknown prices, multiple items, tenant/customer mismatches, missing periods, and ambiguous statuses. Inspect `organization_billing.last_error_code`, billing audit rows, the PgBoss dead-letter queue, and Stripe webhook health. Never repair entitlements by editing `stripe.*`.

Past-due access has a seven-day grace period. Unpaid, canceled after the paid access period, unknown, and quarantined states are no-create; reads and existing data remain intact. Downgrades use Stripe subscription schedules and cancellation uses period-end cancellation.

## Launch exclusions and readiness

Refund workflows, automated tax, coupons, and promotion codes are unsupported at launch. Promotion codes remain disabled in Checkout. Before production enablement:

1. verify live credentials and managed webhook without running the test seed;
2. reconcile the approved live product/price IDs through a controlled live-mode procedure;
3. verify the six amounts, USD currency, intervals, metadata, portal configuration, and invoice links;
4. run application and StripeSync migrations/backfill, migration acceptance, billing smoke, and upload/library/bulk/thumbnail regressions;
5. test successful and failed payments, grace/recovery, scheduled downgrade, cancel/resume, tenant isolation, dead-letter alerting, and rollback procedures.