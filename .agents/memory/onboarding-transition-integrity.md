---
name: Onboarding transition integrity
description: Lock ordering and administrative-state preservation for asynchronous workspace provisioning.
---

Provisioning transitions that touch multiple durable records must acquire or
update the intent first, the organization second, and the provider space third.
Activation, failure, retry, and reconciliation may change an organization only
from an explicitly eligible state; they must never overwrite suspension.

**Why:** Opposite lock orders let an owner retry deadlock with a failing worker,
while unconditional asynchronous updates can undo a concurrent administrative
suspension.

**How to apply:** Keep the ordering consistent in every worker, retry, repair,
and reconciliation path. Require the processing intent, provisioning
organization, and ready unclaimed provider space together before reporting or
committing readiness.