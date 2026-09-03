# Workspace onboarding operations

## Launch and configuration

1. Configure `DATABASE_URL`, `SESSION_SECRET`, `PRODUCT_NAME`, and the normal
   provider credential encryption settings.
2. Run `pnpm --filter @workspace/db run migrate`, followed by
   `pnpm --filter @workspace/db run verify-schema`.
3. Confirm the existing active `growth` plan and at least one provider account
   with available capacity. Production has no fake or in-memory provider
   fallback.
4. Start the API worker. It owns the periodic
   `vid.tenant.onboarding-dispatch` scan and `vid.tenant.provision` work.

The HTTP create route commits the organization, owner membership, permission
catalog, default groups, customization, audit event, and durable provisioning
intent atomically. It never calls a provider. Queue publication may occur after
the response; the database intent is the source of truth and the periodic scan
repairs a crash between commit and publication.

## State and recovery

- `pending`, `dispatching`, and `queued` are repaired automatically using the
  intent UUID as the queue job UUID.
- Dispatch and user retries are bounded to five attempts.
- Provider resolution or capacity failure before a remote call becomes
  `unavailable` and may be retried by the creating owner.
- A definite provider rejection becomes a safe failed state.
- Any interrupted or ambiguous external create call becomes
  `reconciliation_required`. It is never replayed automatically and the public
  API exposes no provider identifiers, credentials, or diagnostic strings.
- An intent is marked `completed` only in the same database transaction that
  activates its organization.

For a retryable failure, correct capacity or provider configuration and ask the
owner to use `POST /api/onboarding/retry`. Operators may also leave the intent
pending; the dispatcher will recover it. For `reconciliation_required`, inspect
the provider and the owned `provider_tenant_spaces` row, determine whether a
remote space exists, and reconcile it manually before changing state. Never
clear an external-call claim merely to force replay.

## Verification and incident checks

Run `pnpm --filter @workspace/api-server run onboarding:smoke` in a test
environment. The smoke uses only an injected fake provider and fake queue seam.
Useful database checks are counts by intent state, intents at five attempts,
and stale `dispatching` claims. Logs should contain IDs and safe diagnostic
codes only; request bodies and provider credentials must not be logged.

External Bunny activation is a separate background integration step. A
successful onboarding HTTP response means the durable request was accepted,
not that Bunny has already created a library.