# Current-State Product Requirements: Multi-Tenant Video Platform

**Status:** Working product baseline with material launch gaps  
**Last reviewed:** September 3, 2026  
**Primary implementation map:** [CODE_REVIEW_GROUPS.md](CODE_REVIEW_GROUPS.md)  
**Original product intent:** `attached_assets/PRD-video-platform_1788432736951.md`

---

## 1. Purpose of this document

This document replaces a greenfield product plan with a requirements baseline
for the product that now exists.

It has three jobs:

1. Describe the product and architecture as they are implemented today.
2. Separate implemented behavior from behavior that is partial, unverified, or
   blocked by an external dependency.
3. Define the next build and refinement requirements without pretending the
   current system is still at the starting line.

This is not a substitute for the detailed review scopes in
[CODE_REVIEW_GROUPS.md](CODE_REVIEW_GROUPS.md). That document remains the
authoritative map for code review, dependencies, and validation commands. This
document describes product completeness and priorities across those groups.

### Status vocabulary

| Status | Meaning |
|---|---|
| **Built** | The capability is implemented in the application and has meaningful local validation. |
| **Partial** | Important parts exist, but at least one user journey, invariant, or acceptance criterion remains incomplete. |
| **Externally gated** | Application code exists, but completion depends on provider accounts, production infrastructure, deployment configuration, or approved live operations. |
| **Unverified** | The code may support the requirement, but there is no adequate evidence for the product or non-functional claim. |
| **Missing** | No complete implementation was found. |

“Built” does not mean “production proven.” Production readiness also requires
the operational gates in [LAUNCH_CHECKLIST.md](../LAUNCH_CHECKLIST.md).

---

## 2. Product definition

The product is a video-provider-portable, multi-tenant video control plane with:

- self-hosted authentication;
- isolated customer workspaces;
- permission groups and plan entitlements;
- direct-to-provider resumable video upload;
- provider-neutral video metadata and lifecycle management;
- an owned player and owned embed URL;
- folders, bulk actions, thumbnails, and video deletion;
- first-party playback analytics;
- billing and subscription lifecycle management;
- audit history;
- workspace player customization;
- DNS ownership verification for custom domains;
- durable background processing and reconciliation.

The application currently serves the tenant product. The operator-facing
platform administration product described in the original PRD has not been
built.

### Current non-goals

The following remain outside the current product unless explicitly promoted by
a later decision:

- live streaming;
- DRM;
- CTAs and lead gates;
- heatmaps and A/B testing;
- chapters editing;
- SAML SSO;
- pooled provider tenancy;
- a public tenant API and outbound webhooks.

Public self-service signup should remain a non-goal until there is an explicit
decision to change the operator-led onboarding model.

---

## 3. Executive assessment

The application is no longer a prototype shell. It contains substantial
production-shaped implementations for tenant-scoped video metadata, durable
jobs, provider provisioning, direct upload, webhook ingest, library operations,
thumbnails, analytics, audit, billing, onboarding, and failure reconciliation.

The strongest implemented areas are:

- durable persistence and migration structure;
- provider-side effect claims and retry handling;
- video library pagination and folder mutation safety;
- raw webhook verification and idempotency;
- thumbnail integrity and cleanup;
- audit-log integrity;
- billing lifecycle serialization;
- analytics ingestion and rollup safety;
- cold-master operation state machines, despite missing production adapters.

The largest differences between the built product and the original product
promise are:

1. **The platform-admin product is missing.**
2. **Tenant selection does not resolve by custom domain, subdomain, path, or
   last-active organization, and there is no multi-workspace switcher.**
3. **Viewer playback still calls the control plane for metadata, analytics
   grants, and provider-source resolution.** The original static edge embed
   architecture is not complete.
4. **Cold-master storage and provider-transfer adapters are unconfigured.**
5. **The provider contract does not yet support captions or direct PUT upload,
   and only Bunny is a functional production provider.**
6. **Workspace logo and watermark assets are modeled but lack a complete upload,
   validation, normalization, and delivery pipeline.**
7. **Custom domains stop at DNS ownership verification; TLS and edge routing are
   not implemented.**
8. **Several launch and performance claims remain unmeasured.**
9. **Invitation creation stops at a pending database record; delivery,
   acceptance, token validation, and atomic membership creation are missing.**
10. **The original promise that auth and CDN dependencies are replaceable is not
    implemented as an adapter boundary.**

The current system should therefore be described as a strong control-plane
baseline, not yet as the complete portable white-label platform promised by the
original PRD.

---

## 4. Current architecture and accepted departures

### 4.1 Application stack

The implemented stack differs from the original Next.js proposal:

- **Frontend:** React + Vite, React Query, Wouter, generated API hooks.
- **API:** Express 5, Zod request/response validation.
- **Authentication:** Better Auth with PostgreSQL/Drizzle.
- **Database:** PostgreSQL, Drizzle schema, immutable SQL migrations, RLS.
- **Jobs:** pg-boss with durable schedules, retries, dead-letter queues, claims,
  and reconciliation flows.
- **Video provider:** provider-neutral contracts with a Bunny implementation.
- **Player:** owned Vidstack player.
- **Billing:** Stripe and Stripe synchronization.
- **Storage:** application object storage for thumbnails; provider-neutral but
  unconfigured cold-master boundaries.

The React/Express split is an acceptable architectural departure. The product
requirements depend on behavior, isolation, and portability, not on Next.js.

### 4.2 Control plane

The API owns:

- authentication and tenant context;
- permissions and entitlements;
- workspace onboarding;
- provider account and tenant-space orchestration;
- video metadata and state transitions;
- upload credential issuance;
- webhook ingestion;
- library, folder, thumbnail, and bulk operations;
- playback-source resolution;
- first-party analytics;
- billing, audit, customization, and domain verification;
- durable background work.

### 4.3 Data plane

Bunny currently supplies provider storage, transcoding, HLS delivery, and
provider-side playback URLs. Browser uploads use TUS directly against the
provider. Video segment bytes do not pass through the application.

However, the viewer journey is not yet fully independent of the control plane.
The public embed application requests video metadata, analytics grants, and an
owned playback-source route that redirects to a short-lived provider URL.

### 4.4 Embed delivery

The application owns the stable `/v/{videoId}` URL, responsive embed code,
player, metadata, and provider-neutral video ID. Provider IDs are not used as
public IDs.

The embed is currently a dynamic React route backed by public API requests. It
is not generated static HTML deployed to an edge/CDN. The zero-control-plane
viewer requirement therefore remains open.

---

## 5. Portability requirements and current status

| Rule | Current state | Remaining requirement |
|---|---|---|
| **P1. Own the embed URL** | **Built.** Embed URLs use the application’s video UUID and owned route. | Prove custom-domain and edge delivery without changing client embed code. |
| **P2. Own the player** | **Built.** The frontend uses an owned Vidstack wrapper rather than a provider iframe. | Add performance evidence, browser coverage, and a true poster facade if required. |
| **P3. Own IDs** | **Built.** Application video IDs and provider asset IDs are distinct. | Continue public-contract tests that prevent provider IDs from leaking. |
| **P4. Own analytics** | **Partial.** First-party grants, event ingestion, rollups, and a dashboard exist. | Complete required referrer, country, device, and player-event product surfaces. |
| **P5. Keep masters** | **Externally gated / incomplete.** Durable archive/restore operations exist, but storage and transfer adapters are unconfigured. | Select and implement a real storage adapter, wire archival into upload completion, and prove restore integrity. |
| **P6. Runtime product name** | **Partial.** The API exposes runtime product configuration. | Remove hardcoded “Video Platform” and placeholder metadata from the web shell and ensure all visible product identity reads runtime configuration. |

Provider portability is structurally real but incomplete. The provider contract
supports TUS and multipart credentials, but not direct PUT. Caption operations
are absent. Bunny is the only functional production adapter.

The broader external-dependency portability promise is not yet implemented:

- Better Auth is imported directly by the application and tenant middleware;
  there is no auth-provider adapter boundary.
- The embed/public-delivery path is application-specific and no replaceable CDN
  publishing interface is present.

These may be acceptable constraints, but they must be explicit product and
architecture decisions rather than assumed portability.

---

## 6. Users, tenancy, and administration

### 6.1 Tenant user

A signed-in tenant user can currently:

- complete workspace onboarding;
- view a dashboard;
- upload videos with progress and same-dialog TUS pause/retry;
- list, filter, search, sort, move, edit, and delete videos;
- organize videos into nested folders;
- manage thumbnails;
- copy embed code and view the owned player;
- view analytics;
- list members and create pending invitation records;
- adjust supported player customization;
- view and export audit history;
- manage billing and workspace settings;
- create and verify custom-domain ownership records.

The exact actions available are constrained by server-side permissions,
entitlements, billing state, and provider availability.

The backend includes permission-group CRUD and member group/status updates, with
checks against administrative lockout and deleting an in-use group. The
frontend does not yet expose that complete lifecycle. Invitation records are
not delivered and cannot be accepted: no usable token is returned or sent, and
no acceptance route atomically creates the membership.

### 6.2 Multi-workspace user

**Status: Missing.**

Tenant context currently resolves the first active membership for the signed-in
user. It does not resolve the organization from:

1. verified custom domain;
2. tenant subdomain;
3. path segment;
4. saved last-active organization.

There is no complete organization switcher or persisted last-active workspace.

### 6.3 Platform operator

**Status: Missing.**

The original PRD requires a platform-level operator who can create and inspect
tenants, assign plans, view provider capacity, search globally, manage platform
configuration, and perform reasoned, audited impersonation.

No complete super-admin field, platform authorization guard, operator API,
operator frontend, impersonation banner, or reason requirement was found.
Tenant routes named “platform” are tenant-scoped and are not a platform-admin
implementation.

### 6.4 Public viewer

A viewer can load an owned embed route and player without seeing provider IDs in
the embed code. Video segments are delivered by the provider.

The viewer still depends on the control plane for public video metadata,
analytics grants/event collection, and provider-source resolution. This is a
known departure from the original zero-control-plane playback acceptance
criterion.

---

## 7. Capability baseline by review group

### G0 — Runtime bootstrap and composition

**Status: Built locally.**

Implemented:

- fail-closed startup configuration;
- safe route and raw-body ordering;
- unauthenticated liveness;
- readiness gating;
- bind-before-side-effect startup;
- partial-worker rollback;
- bounded, single-flight graceful shutdown;
- startup/log redaction safeguards;
- isolated local runtime smoke coverage.

Remaining:

- deployment-level startup and shutdown proof;
- production observability for failed startup and forced shutdown;
- measured restart behavior under active requests and jobs.

### G1 — Authentication, tenant isolation, RBAC, and entitlements

**Status: Partial.**

Implemented:

- Better Auth with PostgreSQL;
- authenticated tenant middleware;
- server-side permission lookup;
- server-side entitlement lookup;
- plan and organization overrides;
- tenant-scoped transaction helper;
- backend permission-group CRUD;
- backend member group/status updates;
- checks against removing the last active member administrator;
- rejection of deleting an in-use group;
- pending invitation records with expiry and member-limit accounting.

Required refinements:

- implement deterministic host/path/last-active tenant resolution;
- add multi-workspace switching;
- decide and enforce 404 versus 403 behavior for unauthorized resolved tenants;
- complete the permission catalog and prove every protected route has the
  intended guard;
- mark and protect system groups;
- expose group/member update behavior in the frontend;
- add explicit member removal behavior if suspension is not sufficient;
- deliver invitation links without exposing stored token material;
- validate expiring invitation tokens;
- accept an invitation and create membership atomically;
- prevent invitation replay and duplicate pending invitations;
- add permission/entitlement cache and explicit invalidation if performance
  targets still require it;
- enforce numeric limits at the action point;
- implement platform-level super-admin separately from tenant groups;
- remove or further isolate development auto-membership behavior.

### G2 — Workspace onboarding and provider provisioning

**Status: Built in code; externally gated for acceptance.**

Implemented:

- authenticated first-workspace onboarding;
- atomic organization, owner membership, defaults, plan, and durable intent;
- idempotent provisioning claims;
- provider-capacity reservation;
- retry and reconciliation-required states;
- durable dispatch and activation.

Remaining:

- prove live Bunny provisioning;
- prove usable onboarding within the target time;
- prove crash/retry behavior with real provider ambiguity;
- add the operator-created-tenant journey if operator-led onboarding remains the
  product model;
- ensure public self-service account/workspace creation cannot bypass that
  decision.

### G3 — Database, migrations, RLS, and grants

**Status: Built in source; production proof required.**

Implemented:

- Drizzle schema and immutable SQL migrations;
- migration ledger and verification tooling;
- tenant RLS policies and scoped transaction settings;
- append-only audit safeguards;
- worker-specific access patterns.

Remaining:

- verify the production runtime uses a least-privileged non-owner role;
- run adversarial cross-tenant tests against an isolated migrated database;
- prove every tenant table is covered by RLS and grants;
- establish approved backup, PITR, restore, and migration rollback evidence;
- confirm connection pooling and concurrency ceilings in the deployment.

### G4 — Provider abstraction and Bunny adapter

**Status: Partial.**

Implemented:

- provider registry and fail-closed unconfigured provider;
- provider-neutral tenant-space, asset, status, playback, and callback types;
- TUS and multipart credential types;
- Bunny provisioning, upload, status, delete, playback, host trust, and webhook
  verification;
- test-only fake adapter and conformance smoke.

Remaining:

- add direct PUT credentials if it remains a portability requirement;
- add caption operations;
- implement or exercise a second non-Bunny adapter strongly enough to prove the
  contract is not Bunny-shaped;
- prove credential encryption, retrieval, rotation, and account capacity in the
  production environment;
- perform the explicitly gated live Bunny round trip.

### G5 — Video upload and lifecycle

**Status: Built locally; externally gated for live acceptance.**

Implemented:

- tenant-scoped upload initialization;
- application-owned video IDs;
- provider asset creation;
- idempotency and quota reservation;
- direct browser TUS upload;
- same-dialog pause, resume, and retry;
- completion/cancellation endpoints;
- verified webhook state transitions;
- durable deletion and reconciliation behavior.

Remaining:

- prove the 2 GB interrupted-upload acceptance case against the live provider;
- make reload/browser-restart recovery coherent: the current upload dialog can
  discover a previous TUS upload only after creating a new video/upload
  reservation, so resuming the old provider upload can acknowledge the wrong
  application video and orphan the new reservation;
- persist and restore the application video ID, upload session, idempotency key,
  and provider upload fingerprint as one recovery record;
- add frontend support for multipart and direct PUT if those methods are
  retained in the portability contract;
- complete real cold-master archival as part of upload success;
- measure upload failure and recovery behavior;
- verify provider deletion ambiguity and webhook races with live credentials.

### G6 — Video library, folders, pagination, and bulk actions

**Status: Substantially built.**

Implemented:

- tenant-scoped listing;
- search, filters, sorting, and folder views;
- signed cursor pagination with snapshot semantics;
- metadata updates;
- bulk metadata and delete operations;
- nested folders with cycle prevention;
- empty-folder deletion checks;
- frontend selection and mutation flows.

Remaining:

- complete end-to-end UI and accessibility review;
- prove pagination and selection behavior at realistic library sizes;
- verify every mutation invalidates or rehydrates the correct query state;
- add any missing tags workflow required by the final product.

### G7 — Embeds, playback, and player security

**Status: Partial.**

Implemented:

- owned embed path and application video ID;
- responsive iframe snippet and JSON-LD metadata;
- owned Vidstack player;
- lazy media loading support;
- short-lived provider playback resolution;
- trusted-host and expiry checks;
- private-video restrictions;
- unavailable/processing/error player states.

Remaining:

- decide whether zero-control-plane viewer playback remains non-negotiable;
- if yes, generate and publish static edge embed assets and eliminate required
  metadata/source calls to the control plane;
- prove no provider hostname appears in embed markup or stable public contracts;
- add an explicit poster-only facade if Vidstack’s lazy loading does not meet the
  product and Core Web Vitals target;
- benchmark time to poster, click-to-first-frame, and rebuffer ratio;
- validate referrer policy and per-tenant playback allow-lists if promoted from
  Phase 2.

### G8 — Thumbnails and object storage

**Status: Built in code; storage deployment must be verified.**

Implemented:

- signed upload lifecycle;
- ownership, content-type, size, and version checks;
- immutable promotion;
- object metadata repair;
- replacement and cleanup safety;
- public serving for eligible videos;
- thumbnail management UI.

Remaining:

- verify production object-storage configuration and CDN behavior;
- add provider poster ingestion if desired;
- keep custom logo/watermark assets separate from thumbnail ownership;
- prove cleanup behavior under concurrent replacement in the deployed storage
  system.

### G9 — Analytics

**Status: Partial.**

Implemented:

- server-issued playback grants;
- bounded, rate-limited event batches;
- append-only event storage;
- dirty-day rollups and retention;
- core plays, sessions, watch time, and completion metrics;
- tenant analytics dashboard and top-video/trend views.

Remaining:

- define the final event contract: the player emits load, play, progress, pause,
  ended, and error, and attempts to flush queued records on visibility/pagehide;
  it does not emit the original PRD’s literal unload event;
- make page-exit delivery reliable enough for the selected analytics guarantee;
- expose referrer, country, and device breakdowns;
- implement analytics export if the entitlement remains promised;
- define fraud/abuse expectations—the current system is not a fraud-grade
  measurement product;
- measure poster visibility, first-frame time, and rebuffer ratio;
- add alerting for ingestion rejection, queue backlog, and rollup drift.

### G10 — Audit

**Status: Substantially built.**

Implemented:

- append-only tenant audit storage;
- nested metadata redaction and payload bounds;
- security-sensitive event writes across major flows;
- signed cursor pagination;
- CSV injection protection and export rate limits;
- filter, detail, pagination, and export UI.

Remaining:

- verify append-only grants in the deployed database;
- complete platform-level operator and impersonation events when those
  capabilities are added;
- review route coverage whenever new mutations are introduced.

### G11 — Billing, plans, and Stripe

**Status: Built in code; externally gated.**

Implemented:

- plan and entitlement catalog;
- synchronized Stripe product/price validation;
- serialized checkout and lifecycle mutations;
- customer-generation safeguards;
- portal, invoice, change, cancel, resume, and reconciliation flows;
- billing UI and redirect reconciliation;
- fail-closed behavior when catalog/provider state is unavailable.

Remaining:

- complete approved live catalog and webhook setup;
- validate payment, recovery, downgrade, cancellation, and replay behavior;
- prove dead-letter monitoring and reconciliation;
- enforce every numeric plan limit at the corresponding product action;
- add per-tenant usage and cost attribution before promising billback.

### G12 — Customization and custom domains

**Status: Partial / externally gated.**

Implemented:

- player accent and control color editing;
- WCAG contrast validation;
- poster treatment;
- entitlement and permission checks;
- customization preview;
- customization persistence and audit;
- custom-domain ownership lifecycle;
- TXT verification, retry, repair, and UI status.

Remaining:

- build customer logo and watermark upload endpoints and UI;
- validate format, dimensions, and size;
- retain original assets and produce normalized delivery variants;
- serve assets through the intended CDN/storage path;
- regenerate or invalidate affected embeds after customization changes;
- implement certificate issuance, edge host routing, and traffic activation;
- prove custom-domain playback without changing previously issued embed code.

### G13 — Cold-master archive and restore

**Status: Durable control flow built; production capability missing.**

Implemented:

- archive/restore API and permissions;
- generation-scoped operations;
- byte-stream integrity, size, hash, and content-type validation;
- durable dispatch and reconciliation states;
- protection against restoring unverified legacy archives;
- test seams and lifecycle smokes.

Remaining:

- choose the production cold-storage provider;
- implement the byte-storage adapter;
- implement provider source/restore transfer;
- archive the master as part of the upload lifecycle;
- prove restore to a replacement provider;
- document retention, deletion, cost, and disaster-recovery policy.

### G14 — Durable jobs and workers

**Status: Strongly built in code; operational proof required.**

Implemented:

- pg-boss with retries, backoff, expiration, retention, and dead-letter queues;
- durable claims and deterministic job identities;
- scheduled repair/dispatch workers;
- onboarding, upload expiry, embed, thumbnail, billing, analytics, domain, and
  master-storage jobs;
- partial-start rollback and graceful worker shutdown.

Remaining:

- production queue observability and alerting;
- dead-letter inspection and replay procedures with evidence;
- crash/restart and active-claim shutdown tests;
- capacity and concurrency tuning;
- confirmation that one queue failure does not suppress unrelated workers.

### G15 — OpenAPI and generated clients

**Status: Built, with ongoing parity risk.**

Implemented:

- OpenAPI 3.1 source;
- generated Zod runtime schemas;
- generated React Query clients;
- explicit server-side request and response parsing.

Remaining:

- add operator APIs when platform administration is built;
- keep every runtime route and sensitive response synchronized;
- add a reproducible parity check around code generation;
- preserve strict union validation for upload and lifecycle bodies.

### G16 — Tenant frontend

**Status: Broadly built, not fully product-complete.**

Implemented:

- authentication and onboarding gates;
- dashboard;
- video library and detail;
- upload;
- folders and bulk actions;
- player and embed route;
- analytics;
- member list and invitation creation;
- customization and domains;
- audit;
- billing/settings;
- loading and error boundaries for major shell transitions.

Remaining:

- build platform-admin frontend separately;
- build workspace switching;
- build permission-group and member-status management UI;
- build invitation acceptance UX after the secure acceptance API exists;
- remove hardcoded and placeholder product branding;
- complete mutation error and query-refresh review;
- complete responsive, keyboard, screen-reader, and direct-navigation review;
- verify every permission and entitlement state has a clear denied/disabled UI;
- replace stale placeholder page metadata and favicon handling.

### G17 — Operations, documentation, mocks, and security

**Status: Strong documentation; launch remains gated.**

Implemented:

- launch, incident, recovery, provider outage, onboarding, billing, analytics,
  audit, domain, and master-storage runbooks;
- explicit mock and placeholder register;
- local smoke matrix;
- fail-closed provider and storage behavior;
- migration and rollback guidance.

Remaining:

- remove stale step-number language and obsolete scaffold notes;
- keep mock register synchronized with code;
- gather production evidence for database roles, RLS, queues, external
  providers, backups, and recovery;
- run security/dependency review as part of release acceptance;
- ensure documentation never promotes a configured adapter as a healthy one.

---

## 8. Updated product requirements

The requirements below are incremental. They assume the existing implementation
is retained and refined rather than rebuilt.

### R1. Platform administration

Build a platform-level operator product separate from tenant RBAC.

**Required:**

- platform-level super-admin identity;
- operator-only API and frontend;
- tenant list and detail;
- tenant creation and provisioning status;
- plan assignment;
- provider account capacity and health view;
- global video search with explicit operator authorization;
- reason-required tenant impersonation;
- persistent impersonation banner;
- append-only audit events for every operator action.

**Acceptance:**

- tenant permissions cannot grant platform access;
- impersonation cannot start without a reason;
- the UI cannot conceal that impersonation is active;
- every operator read/write is distinguishable in audit history.

### R2. Deterministic tenant resolution and switching

Resolve tenant context using the agreed priority:

1. active custom domain;
2. tenant subdomain;
3. explicit path or workspace selector;
4. saved last-active organization.

**Acceptance:**

- client-supplied organization IDs are never trusted directly;
- a user cannot infer another tenant’s existence;
- multi-workspace users can switch without signing out;
- the chosen workspace persists safely;
- every tenant transaction sets the correct RLS context.

### R3. Complete authorization invariants

Retain centralized permission checks and finish the group lifecycle.

**Acceptance:**

- the permission catalog covers every product action;
- system groups are identifiable and protected from deletion;
- existing in-use group and administrator-lockout safeguards remain covered by
  regression tests;
- the frontend supports group creation, editing, member reassignment, and member
  status changes without bypassing those safeguards;
- permission changes take effect within the declared cache interval;
- route-coverage tests identify unguarded tenant mutations.

### R3a. Complete invitation delivery and acceptance

Pending invitation records are not a complete member-invitation product.

**Acceptance:**

- the raw token is generated once, delivered through the approved product-
  branded channel, and never stored in plaintext;
- acceptance validates hash, expiry, email identity, tenant, and invitation
  state;
- invitation acceptance and membership creation are atomic;
- replay and duplicate acceptance are rejected;
- pending invitations can be revoked and reissued;
- user-limit accounting remains correct under concurrent create/accept/revoke;
- invitation and acceptance events are audited without recording the token.

### R4. Enforce plan limits

Boolean entitlements and numeric limits must both be enforced server-side.

**Acceptance:**

- user limits block invites before side effects;
- video/storage limits block upload reservation before provider asset creation;
- bandwidth rules have a defined measurement and enforcement policy;
- errors explain the limit and remediation;
- plan overrides are auditable.

### R5. Prove live provider onboarding and lifecycle

Use the existing claims, intents, and reconciliation flows against an approved
provider environment.

**Acceptance:**

- a tenant becomes usable within the selected target;
- duplicate or interrupted provisioning does not create unclaimed spaces;
- upload, callback, playback, and delete complete end to end;
- provider ambiguity transitions to reconciliation rather than false success;
- capacity selection remains correct under concurrent onboarding.

### R6. Complete master retention

Implement the production cold-master strategy rather than only its state
machine.

**Acceptance:**

- every successful upload either has a verified master archive or a visible,
  retryable archive state;
- archive metadata is cryptographically bound to actual bytes;
- restore targets the correct tenant and generation;
- a restore can create a valid asset at a replacement provider;
- retention/deletion behavior is documented and auditable.

### R7. Decide and implement the final embed architecture

Make an explicit product decision between:

- **static edge embed delivery**, preserving the original zero-control-plane
  viewer requirement; or
- **dynamic control-plane resolution**, accepting the availability and latency
  dependency and revising the product promise.

If static edge delivery remains required:

- generate versioned embed assets;
- publish them to owned edge storage/CDN;
- resolve provider playback without a required control-plane request;
- preserve analytics without exposing provider IDs;
- invalidate/regenerate on metadata and customization changes.

### R8. Complete provider portability

**Required if the original portability promise remains:**

- direct PUT upload credentials;
- captions in the provider contract;
- one second adapter or rigorous provider-independent contract fixture;
- provider-independent restore;
- migration rehearsal using retained masters.

Also decide whether the original “every external dependency is replaceable”
statement remains a requirement. If it does, add explicit auth-provider and CDN
publishing boundaries and prove them independently. Otherwise narrow the
portability claim to the video provider and retained media.

### R9. Finish customization assets

**Acceptance:**

- customer logo and watermark upload is available in the product;
- only approved formats, dimensions, and sizes are accepted;
- originals and normalized variants are retained;
- embeds receive updated assets within the declared interval;
- application chrome remains product-branded rather than tenant-reskinned;
- asset URLs cannot cross tenant boundaries.

### R10. Complete analytics product requirements

**Acceptance:**

- player event behavior is documented and tested;
- top referrers, countries, and devices are visible;
- completion and watch-time calculations are stable under retries;
- analytics export is gated and functional if sold;
- performance telemetry measures poster display, first frame, and rebuffering;
- the system clearly states whether numbers are directional or billing-grade.

### R11. Activate custom domains

DNS verification alone is not completion.

**Acceptance:**

- verified domains receive certificates;
- edge routing maps the hostname to the correct tenant;
- activation and removal are reversible and audited;
- failed issuance/renewal has a visible repair state;
- internal/private hostnames remain prohibited;
- old embed code continues to work.

### R12. Complete runtime product branding

**Acceptance:**

- HTML title, description, social metadata, favicon, login, shell, emails, and
  default player identity use runtime product configuration;
- changing `PRODUCT_NAME` requires no source edit;
- internal `vid` identifiers never become customer-facing branding.

### R13. Establish production evidence

The following claims require measured or operational evidence:

- dashboard p95 under the selected target;
- tenant resolution and permission-check latency;
- poster display and click-to-first-frame latency;
- rebuffer ratio;
- hundreds-tenant database/queue behavior;
- backup and PITR restoration;
- provider outage behavior;
- dead-letter observation and replay;
- billing reconciliation;
- cross-tenant RLS resistance;
- cost and usage attribution.

---

## 9. Priority plan

### Priority 0 — Required before claiming the original MVP

1. Complete tenant resolution, multi-workspace selection, and authorization
   invariants.
2. Complete invitation delivery, acceptance, revocation, and frontend member
   administration.
3. Build platform administration or explicitly redefine onboarding as
   tenant-self-service.
4. Prove RLS and least-privilege deployment behavior.
5. Validate live Bunny onboarding, upload, webhook, playback, and deletion.
6. Implement real cold-master storage and restore.
7. Decide and close the static-edge versus dynamic embed architecture gap.
8. Enforce numeric plan limits.
9. Remove hardcoded product branding and placeholder metadata.
10. Establish queue, dead-letter, backup, and recovery evidence.

### Priority 1 — Required for the intended commercial product

1. Finish logo/watermark asset handling and embed regeneration.
2. Complete live Stripe lifecycle validation.
3. Activate custom-domain TLS and edge routing.
4. Complete analytics breakdowns and player performance telemetry.
5. Add operator/provider capacity and cost visibility.
6. Complete frontend accessibility, responsive, and error-state review.

### Priority 2 — Portability and Phase 2 completion

1. Add captions.
2. Add direct PUT and frontend multipart support.
3. Build or rehearse a second provider adapter.
4. Add per-tenant referrer allow-lists and expiring playback policy.
5. Add engagement graph and analytics export if commercially required.
6. Add per-tenant usage and cost dashboard.
7. Add video replacement and custom poster workflows.

### Deferred Phase 3

- CTAs and lead gates;
- chapters;
- heatmaps;
- A/B testing;
- DRM;
- SAML SSO;
- public tenant API and outbound webhooks;
- pooled provider tenancy.

---

## 10. Product decisions still required

1. Is zero-control-plane viewer playback still a hard requirement?
2. Which cold-storage provider will retain masters?
3. Must platform administration exist before the first pilot, or will tenant
   self-onboarding become an intentional product change?
4. Is billing required for launch, or may tenants be assigned plans manually?
5. Are custom domains required for launch or explicitly Phase 2?
6. What is the canonical tenant resolution model for the first release:
   subdomain, path, workspace selector, or a combination?
7. Should unauthorized tenant resolution return 404 in all cases?
8. Are Owners/Editors/Viewers the intended system groups, or should the product
   return to Owner/Manager/Contributor?
9. Are system groups editable, and which of them are undeletable?
10. Are captions and direct PUT mandatory portability requirements?
11. Does “replaceable external dependencies” still include authentication and
    CDN delivery, or should the promise be narrowed to video providers?
12. Is an unload event required, or is durable pagehide/visibility flushing the
    intended analytics contract?
13. Are analytics directional product metrics or billing-grade records?
14. What exact performance targets remain contractual rather than aspirational?

These decisions should be recorded before implementing dependent work. Otherwise
the code will continue to support conflicting product models.

---

## 11. Validation and completion policy

Every requirement completed from this document must also pass the relevant
review group in [CODE_REVIEW_GROUPS.md](CODE_REVIEW_GROUPS.md).

Completion requires:

1. code and schema;
2. local validation;
3. negative and cross-tenant tests where applicable;
4. operational documentation;
5. explicit external validation for provider or infrastructure behavior;
6. removal or update of related entries in [MOCKS.md](../MOCKS.md);
7. truthful launch-checklist status.

Do not mark a feature complete because:

- an adapter is configured;
- a database table exists;
- a UI control exists without a working backend;
- a backend route exists without a usable user journey;
- a smoke uses a test-only fake;
- a remote dependency worked once without retry/recovery validation.

---

## 12. Honest risk list

### Embed architecture risk

The current owned player and IDs preserve meaningful portability, but dynamic
source resolution makes control-plane availability part of playback startup.
Leaving this undecided creates both product and infrastructure ambiguity.

### Authorization risk

Tenant isolation has strong database foundations, but tenant selection, group
invariants, super-admin separation, and complete guard coverage remain
high-consequence work.

Invitation rows currently cannot become memberships through a secure acceptance
flow. Treating pending records as completed invitations would create both a
product dead end and pressure to add an unsafe token shortcut later.

### Master-retention risk

Without a configured cold-master path, provider migration and disaster recovery
remain theoretical despite the strong operation state machine.

### External-proof risk

The repository contains many carefully designed local smokes. They do not prove
live Bunny, Stripe, DNS/TLS, object storage, or production database behavior.

### Product-surface risk

The tenant UI is broad, but the missing operator product, workspace switching,
asset pipeline, and incomplete analytics/custom-domain surfaces prevent the
application from satisfying the complete original product story.

### Portability overstatement risk

“Provider-neutral” is accurate for much of the control plane. “Provider
replaceable in a week” is not yet demonstrated without a second adapter,
captions/direct PUT coverage, retained masters, and a migration rehearsal.
Authentication and CDN delivery are also directly coupled despite the original
broader portability statement.

### Performance risk

The original latency and playback targets are not established by current tests.
They should not be used in sales or launch claims until instrumented and
measured.

---

## 13. Related source documents

- [Original Product Requirements](../attached_assets/PRD-video-platform_1788432736951.md)
- [Code Review Groups](CODE_REVIEW_GROUPS.md)
- [Production Launch Checklist](../LAUNCH_CHECKLIST.md)
- [Mock and Placeholder Register](../MOCKS.md)
- [Incident Response](../INCIDENT_RESPONSE.md)
- [Recovery Operations](../RECOVERY_OPERATIONS.md)
- [Provider Unavailable Operations](../PROVIDER_UNAVAILABLE_OPERATIONS.md)
- [Onboarding Operations](../ONBOARDING_OPERATIONS.md)
- [Stripe Operations](../STRIPE_OPERATIONS.md)
- [Analytics Operations](../ANALYTICS_OPERATIONS.md)
- [Audit Operations](../AUDIT_OPERATIONS.md)
- [Custom Domain Operations](../CUSTOM_DOMAIN_OPERATIONS.md)
- [Master Storage Operations](master-storage-operations.md)
