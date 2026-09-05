# Security release review

This file records source-level security acceptance separately from installed
package and production-environment evidence. A generated lockfile is not proof
that its package archives were installed or that production controls are healthy.

## Local source review — 2026-09-04

- Dependency audit after lock-policy remediation: 0 critical, 0 high,
  0 moderate, 0 low.
- Static application scan: 0 findings.
- Privacy and security dataflow scan: 0 findings.
- Secret review found no credential values in source or artifact manifests.
  Test-only credential-shaped fixtures remain randomized or explicitly
  suppressed at their exact test lines.
- The public playback redirect is a reviewed static-analysis exception at the
  exact redirect sink. Before redirecting, the provider adapter attests the
  asset-bound HTTPS source and the API rechecks current video eligibility after
  provider I/O. This exception must not be broadened to other redirects.

The dependency policy pins patched transitive releases for the reviewed
esbuild, Nano ID, qs, and UUID advisories. Each override records its advisory
and retirement condition. Strict peer checking remains enabled; the only
allowed-version exceptions are parent-qualified Better Auth and Vidstack
declarations covered by typecheck/build and the relevant smoke suites.

## Installed-package acceptance gate

The patched package archives were not present in the offline package store.
Because this review prohibited registry access, a clean installation of the
remediated lockfile was not performed. Before release:

1. perform a clean, frozen-lockfile install through the approved package
   registry/firewall;
2. rerun the full workspace typecheck and build against that installed graph;
3. rerun all three security scans and retain their results;
4. do not release if the installed graph differs from the reviewed lockfile or
   any advisory remains.

## Operational security gates

The database-backed smoke matrix, provider round trip, App Storage round trip,
thumbnail cleanup, and Stripe catalog seed were not run. Their package
entrypoints now require dedicated isolated-test variables or explicit
authorization phrases and fail before building or connecting when those inputs
are absent.

Production database roles/RLS, queue recovery, Bunny behavior, Stripe live
lifecycle, custom-domain TLS/edge routing, cold storage/provider transfer,
backup/restore, and incident recovery remain external evidence requirements in
[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md).