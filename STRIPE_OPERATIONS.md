# Stripe billing operations

## Environment separation

Development must use the connected Stripe **test** account (`sk_test_`). The catalog reconciler refuses an unrecognized key and exits before any write for `sk_live_`. Live catalog setup is a separate production-readiness operation and must never be copied from database rows.

Stripe credentials are fetched on every operation through the Replit connector. They must not be stored, logged, or added to environment files. Startup requires `DATABASE_URL`, `REPLIT_CONNECTORS_HOSTNAME`, Replit workload identity, and `REPLIT_DOMAINS`.

## Startup and webhook

Application public-schema migrations run through `@workspace/db`. StripeSync then runs its own migrations, constructs the sync client, finds or creates the managed webhook at `/api/stripe/webhook`, and performs backfill in that order. StripeSync exclusively owns `stripe.*`; application migrations and catalog fingerprints intentionally exclude it.

The webhook route is registered with `express.raw` before JSON parsing. StripeSync verifies the signature and ingests its provider-owned projection first. The application then records a unique, payload-free receipt, maps it only through application-owned customer/subscription/checkout-session bindings, and reconciles current Stripe authority under the organization lifecycle lock. Metadata is a consistency check, never a tenant selector. Duplicate and older deliveries cannot apply payload state.

Receipt processing uses a five-minute claim lease. Transient reconciliation failures remain retryable; a five-minute PgBoss sweep reclaims failed or abandoned receipts. Receipts retain only normalized provider object/customer/subscription/Checkout Session IDs, never payloads. Events that arrive before their application binding remain pending for up to 24 hours and are retried by Stripe and the sweep. Ambiguous or changed bindings are quarantined; still-unbound receipts expire as ignored without adopting a tenant. Confirm the managed endpoint URL, application receipt state, and delivery health in each environment after a domain change.

## Catalog

Run:

```sh
pnpm --filter @workspace/scripts stripe:seed
```

The command is idempotent, test-mode only, reads the three approved commercial plans and amounts from the application plan policy, uses stable metadata and idempotency keys, requires exactly three active managed products and six recurring USD prices, transactionally records relationship IDs, then runs StripeSync backfill. A duplicate or amount/interval conflict stops reconciliation for operator review rather than silently selecting a product.

## Reconciliation and incidents

PgBoss reconciles active and at-risk subscriptions every five minutes. Workspace managers may trigger bounded repair through `POST /api/billing/reconcile`. Reconciliation retrieves the authoritative subscription from Stripe. Authority/integrity failures (unknown prices or statuses, multiple items/subscriptions, tenant/customer mismatches, and missing periods) commit a quarantine projection. Network and provider-availability failures preserve the last access projection, record a stable retryable diagnostic, and fail the job so PgBoss retry/dead-letter policy remains effective. Inspect `organization_billing.last_error_code`, `billing_event_receipts`, billing audit rows, the PgBoss dead-letter queue, and Stripe webhook health. Never repair entitlements by editing `stripe.*`.

Past-due access has a seven-day grace period. Unpaid, canceled after the paid access period, unknown, and quarantined states are no-create; reads and existing data remain intact. Downgrades use Stripe subscription schedules and persist the verified schedule ID and effective period end. A missing/mismatched schedule clears the pending downgrade and records `stripe_downgrade_schedule_missing` without revoking otherwise-authoritative paid access. Cancellation uses period-end cancellation.

## Launch exclusions and readiness

Refund workflows, automated tax, coupons, and promotion codes are unsupported at launch. Promotion codes remain disabled in Checkout. Before production enablement:

1. verify live credentials and managed webhook without running the test seed;
2. reconcile the approved live product/price IDs through a controlled live-mode procedure;
3. verify the six amounts, USD currency, intervals, metadata, portal configuration, and invoice links;
4. run application and StripeSync migrations/backfill, migration acceptance, billing smoke, and upload/library/bulk/thumbnail regressions;
5. test successful and failed payments, grace/recovery, scheduled downgrade, cancel/resume, tenant isolation, dead-letter alerting, and rollback procedures.