# PRD: Multi-Tenant White-Label Video Platform

**Owner:** Jason Roach, Anchor Point LLC
**Status:** Ready to build

---

## 1. Overview

A multi-tenant video hosting platform with a single product brand. One operator (Jason), many customer organizations. Each organization is an isolated tenant with its own users, its own permission groups, its own video library, and plan-gated workspace customization (their logo, their player styling, optionally their own embed domain). Video bytes never touch the application.

The defining architectural constraint: **every external dependency is replaceable.** The video provider, the auth provider, and the CDN can each be swapped by writing an adapter and flipping a config value, without touching a single client's embedded HTML.

**Goals**

1. Onboard a company in under two minutes, fully provisioned and on a plan.
2. Each company defines its own permission groups.
3. Each company gets logo, colors, subdomain, and optionally a custom domain, across app, login, email, player, and embed.
4. Scale to hundreds of companies without rearchitecting.
5. Zero video bytes and zero viewer traffic through the control plane.
6. Provider migration costs days, not months.

**Non-goals.** Live streaming. Public self-serve signup. CTAs and lead-gate forms, heatmaps, A/B testing (Phase 3). DRM (Phase 3 toggle).

**Success criteria.** New tenant live and usable in under two minutes. Custom permission group takes effect immediately. Viewers never hit the control plane. p95 dashboard under 400ms warm. Swapping video providers requires zero changes on client websites.

---

## 2. Provider strategy and playback performance

### 2.1 Decision

**Bunny Stream is the video provider.** It bundles storage, transcoding, an adaptive bitrate ladder, HLS packaging, CDN delivery, thumbnails, captions, and signed playback tokens, with strong North America and Europe latency and a 99.99% SLA. At the volumes this platform will see, it is the correct choice and no further comparison is needed to start building.

Reference cost for guardrails: storage $0.01/GB/month, delivery $0.005 to $0.01/GB in NA and EU, H.264 transcoding up to 1080p free, $1/month account minimum.

### 2.2 Why the architecture must not assume Bunny

Provider choice is a business decision that will be revisited. The likely reasons are volume economics (egress becomes the dominant line item and a zero-egress option like Cloudflare R2 becomes worth the operational cost), a terms or pricing change, a capability Bunny does not offer, or a reliability problem.

None of those are predictable, and all of them are expensive to respond to if the provider is wired through the codebase. So the requirement is not "plan to leave Bunny." It is **"never make leaving expensive."**

Concretely, that means a provider swap should cost: write one adapter implementing the interface in section 4, re-upload masters from cold storage, flip a per-tenant config value, regenerate manifests. Roughly a week. It must not cost: touching client websites, reissuing embed codes, migrating analytics history, or rewriting application code.

**A replacement provider must be able to supply, or be paired with something that supplies:** durable storage, transcoding to a multi-rendition ladder, HLS or DASH manifests, CDN delivery, resumable or multipart upload credentials, signed or token-authenticated playback URLs, and an encode-completion callback. The adapter interface in section 4 is shaped around exactly that list, not around Bunny's API surface. If a capability exists in Bunny but not in the interface, it stays out of the interface.

**Migration trigger:** revisit the provider when sustained delivery crosses roughly 50 TB/month, or if Bunny materially changes terms, pricing, or reliability.

### 2.3 What actually determines playback speed

This matters more than provider choice and is worth engineering effort. The latency difference between major CDNs is roughly 15ms. Time to first frame on a typical embed runs 500 to 1,500ms. The CDN is not the variable.

In order of impact:

1. **Sequential round trips before the first video byte.** Embed page, then player JS, then manifest, then variant playlist, then first segment. Four sequential hops at 80ms each is 320ms of nothing happening. Use preconnect and dns-prefetch hints to the video host, inline the manifest reference in the embed page, and avoid any chain where one fetch must complete before the next URL is known.

2. **First segment size.** The player downloads the lowest-bitrate rendition first, then ramps up. A 720p bottom rung at 2 Mbps with 10-second segments means a 2.5 MB first fetch before anything renders. A 360p bottom rung with 4-second segments makes it roughly 180 KB. **This single configuration choice moves startup time more than every other factor combined.** Configure the ABR ladder with a genuinely low bottom rung and short segments.

3. **Poster facade.** Do not initialize the player on page load. Render a poster image and a play affordance; instantiate the player on click or on scroll into view. Perceived load becomes instant, and the entire cost moves off the client page's critical path. This is also what protects the client site's Core Web Vitals, which matters because a slow embed becomes their SEO problem and therefore your support ticket.

4. **Cache hit ratio.** A cold edge means an origin pull. For a long-tail library where most videos are watched rarely, cold-cache first views are the real latency problem, not steady-state performance. Consider pre-warming edges for videos on high-traffic client pages.

5. **Segment format.** CMAF with 2 to 4 second segments starts faster than 10-second TS segments.

**Performance targets:** poster visible immediately (it is a static image on a CDN-cached page). Time to first frame under 800ms on a warm cache after the user clicks play. Rebuffer ratio under 1%. Instrument all three via the first-party beacon so these are measured, not assumed.

---

## 3. Portability rules (non-negotiable)

Referred to throughout as P1 through P6. These are hard constraints, not preferences. Each one exists because violating it makes a provider or platform change disproportionately expensive later.

These five rules are what make the migration thesis real. Violating any one makes a provider switch effectively impossible.

**P1. Own the embed URL.** Every embed code you ever issue points at your domain:

```html
<div style="position:relative;padding-top:56.25%">
  <iframe src="https://embed.yourdomain.com/v/{your_uuid}"
          loading="lazy" allowfullscreen
          style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
</div>
```

That page resolves the video through the provider adapter and loads your player against whatever manifest URL comes back. Client websites never see a provider hostname. A provider switch is invisible to them.

**P2. Own the player.** Use hls.js, Vidstack, or Video.js in a thin wrapper. Never ship the provider's iframe player to a client site. Cost: about three days. Benefit: the entire migration thesis, plus full control over player styling, plus first-party analytics events.

**P3. Own your IDs.** `videos.id` is a UUID you generate. The provider's asset ID lives in `provider_asset_id` alongside a `provider` column. Provider IDs never appear in a URL, an embed, or a public API response.

**P4. Own your analytics.** Emit a first-party beacon into your own table from day one. Do not proxy provider stats. Bunny's statistics endpoint returns only aggregate views, watch time, country breakdowns, and an engagement score, with no per-viewer, referrer, or device data. You need those anyway, and building your own means the analytics survive a provider change.

**P5. Keep the masters.** Store source files in cold storage (Backblaze B2 at roughly $6/TB/mo, or Cloudflare R2). Without masters, migrating means re-encoding from already-lossy output, or not migrating at all. At 1.5 TB this is about $9/month for the option to leave.

**P6. The product name is runtime configuration, never an identifier.** There is one product brand: the name of this application. It is not chosen yet, and it may change later. Nothing in the codebase may depend on it.

Use `vid` as the internal namespace everywhere a short prefix is genuinely needed: repo name, package name, database name, env var prefix, CSS prefix. It is short, neutral, descriptive, and carries no brand meaning, so it never has to change.

Forbidden anywhere in source: the product name in a file name, directory name, package name, class, function, variable, database table, column, enum value, CSS class, environment variable key, or type. If the product were called Foo, then no `FooPlayer`, no `foo-config.ts`, no `FOO_API_KEY`.

| Instead of | Use |
|---|---|
| `FooPlayer.tsx` | `VideoPlayer.tsx` |
| `fooClient.ts` | `apiClient.ts` |
| `FOO_API_KEY` | `VID_API_KEY` |
| `foo_videos` table | `videos` |
| `.foo-header` | `.app-header` |

The displayed product name comes from one config value, `PRODUCT_NAME`, read at runtime. Page titles, email subjects, the login screen, the admin chrome, and the default player watermark all read from it. Renaming the product should be a single config edit touching zero source files. If a rename would require a find-and-replace across the codebase, the rule has been broken.

---

## 4. Provider adapter interface

Everything provider-specific lives in `lib/providers/`. Nothing else in the codebase imports a provider SDK.

```ts
interface VideoProvider {
  readonly name: string

  createTenantSpace(orgId: string, opts): Promise<TenantSpace>
  deleteTenantSpace(space: TenantSpace): Promise<void>

  createAsset(space, meta: AssetMeta): Promise<AssetRef>
  getUploadCredentials(space, assetId): Promise<UploadCreds>
  getAssetStatus(space, assetId): Promise<AssetStatus>
  deleteAsset(space, assetId): Promise<void>

  getPlaybackSources(space, assetId, opts): Promise<{
    hlsUrl: string
    posterUrl: string
    expiresAt?: Date
  }>

  addCaption(space, assetId, lang, vtt): Promise<void>
  listCaptions(space, assetId): Promise<Caption[]>

  verifyWebhook(rawBody: Buffer, headers): NormalizedEvent | null
}
```

`UploadCreds` must be generic enough to express tus (Bunny), S3 multipart (S3-compatible stores such as Cloudflare R2), and direct PUT. Return a discriminated union: `{ kind: 'tus', endpoint, headers } | { kind: 's3-multipart', parts } | { kind: 'put', url }`. The client upload component branches on `kind`.

**Write a second adapter stub early**, even a non-functional one, to force the interface to be genuinely generic rather than Bunny-shaped with renamed fields.

---

## 5. Tenancy and scale ceilings

**Bunny caps accounts at 500 zones** (accounts created 2024 onward), and video libraries count against it. Plan for three tiers:

- **Tier A, dedicated library (default, tenants 1 to ~450).** Full physical isolation, per-tenant provider config, per-tenant token keys.
- **Tier B, pooled space (trials, tiny tenants).** Shared library separated by collections plus mandatory `organization_id` filtering plus token-authenticated playback. Weaker isolation. Build only when tenant count approaches 400.
- **Tier C, additional provider accounts (beyond ~450).** Route new tenants to a second Bunny account. This is why `provider_account_id` is a column and not an env var.

**Design rule:** never hardcode a single provider credential. All provider credentials resolve through a `provider_accounts` table plus a secrets lookup, keyed off the tenant.

Other ceilings: Postgres connection exhaustion breaks first under concurrency, so use a pooler from day one. Replit Autoscale is fine for the dashboard at hundreds of tenants because viewer traffic bypasses it entirely.

---

## 6. Auth and authorization

**Better Auth, self-hosted.** Users, sessions, and organizations live in your Postgres. No MAU or MAO metering, no cost ceiling, fully portable. Clerk would charge $100/mo ($85 annual) for the B2B add-on the moment you need custom permission groups, and you have to build the RBAC layer yourself regardless. WorkOS stays in the back pocket for the first client who demands SAML SSO (Phase 3).

**Permissions** are flat string keys, checked server-side:

```
video.upload    video.read      video.update      video.delete
video.publish   folder.manage   embed.generate
analytics.read  analytics.export
member.invite   member.remove   member.update_group
group.manage    branding.manage settings.manage
apikey.manage   audit.read
```

**Groups** are named permission bundles scoped to a company. Every org is seeded with three editable-but-undeletable system groups (Owner, Manager, Contributor). Admins with `group.manage` create additional custom groups with any subset of permissions.

**Super admin** is a platform-level flag on the user record, checked before org scoping. Never model it as a group inside an org. Every super-admin action is audit-logged and banner-flagged in the UI.

**Enforcement.** One helper, used everywhere:

```ts
requirePermission(ctx, 'video.delete')
// session -> user -> resolved org -> group -> permission set
// throws 403 before any query runs
```

Cache the resolved permission set keyed by `{userId, orgId}` with short TTL, invalidated on group change. Never trust an `org_id` from the client; derive it from session plus resolved host.

---

## 7. Tenant resolution, product brand, and workspace customization

### 7.1 Two layers, not one

There is **one product brand**: this application's name and identity, owned by the operator. Every customer sees it. It is the product they logged into.

On top of that, a customer organization can apply **limited workspace customization**: their own logo alongside the product identity, and their own styling on the video player. They do not reskin the application.

| Layer | Owner | Scope | Changeable |
|---|---|---|---|
| Product brand | Operator | App name, product logo, app color scheme, favicon, email sender identity, marketing surfaces | Config value, one edit |
| Workspace customization | Customer org | Their logo in their workspace header, player control colors, player watermark logo, poster styling | Per org, in the app, plan-gated |

**What a customer can change:** their logo in their own workspace UI, video player control and accent colors, a watermark logo on the video itself, and the embed poster treatment.

**What a customer cannot change:** the application's color scheme, layout, navigation, typography, or product name. The app looks like the product for everyone.

This is deliberate. Full per-tenant reskinning multiplies your QA surface by the number of customers and produces support tickets about layouts you never designed. Scoped customization gets 90% of the perceived value for 10% of the maintenance.

### 7.2 Plan gating

Customization is an entitlement, not a universal feature. Model plans and entitlements from day one, even if there is only one plan at launch, because retrofitting entitlement checks across a live app is miserable.

Suggested entitlement keys:

```
branding.logo            branding.player_colors
branding.watermark       branding.custom_domain
limits.max_users         limits.max_storage_gb
limits.max_videos        limits.monthly_bandwidth_gb
feature.custom_groups    feature.api_access
feature.captions         feature.analytics_export
```

Check entitlements in the same guard path as permissions: `requirePermission` answers "is this user allowed," `requireEntitlement` answers "does this plan include it." Both resolve from the request context. UI hides gated controls; the server still enforces, because hiding a button is not access control.

### 7.3 Domains

Path-based (`app.domain.com/acme`) for platform admin and early tenants. Subdomain (`acme.domain.com`) as the standard default, needing one wildcard DNS record and cert. Custom domain (`video.acmecorp.com`) in Phase 2, plan-gated, needing per-domain TLS.

**Resolution order** in middleware: custom domain, then subdomain, then path segment, then last active org. Resolve once, attach to request context.

Note that a custom domain on the embed URL is the customization most worth selling. It is the only one a client's own visitors actually see.

### 7.4 Implementation

Product theme is a static config. Workspace customization is data, stored per org and injected as CSS custom properties on the server-rendered shell. Tailwind reads from the variables. No per-tenant compiled CSS.

```css
/* product-level, from config */
:root {
  --app-primary: #0F4C81;
  --app-fg:      #101418;
  --app-bg:      #FFFFFF;
  --app-radius:  8px;
}

/* org-level, from the database, player scope only */
[data-org-theme] {
  --player-accent:     #F2A65A;
  --player-control-fg: #FFFFFF;
  --player-control-bg: rgba(0,0,0,0.6);
}
```

Because you own the player (rule P2), player customization is CSS variables rather than a provider setting. That means it survives a provider swap and is not limited to what Bunny's player exposes.

Validate minimum contrast ratio on player colors at save time. Customers will pick unreadable combinations, and a broken-looking player reflects on the product, not on them.

**Asset handling.** Customer logos are uploaded, validated (format, dimensions, file size), and served from CDN. Store an original plus a normalized render. A 6 MB PNG in a player watermark is a real performance regression.

---

## 8. Architecture

**Control plane** (Replit Autoscale + Postgres). Next.js App Router. Tenant middleware, Better Auth, RBAC, video metadata, provider orchestration, upload credential minting, webhook receiver, embed generation, analytics, customization and entitlements.

**Data plane** (Bunny Stream today, swappable). Storage, transcoding, HLS, CDN.

**Cold storage** (Backblaze B2 or Cloudflare R2). Source masters. Write-once, read-on-migration.

**Job queue.** pg-boss, Postgres-backed, no extra infrastructure. Handles tenant provisioning, customization sync, embed regeneration, analytics rollups, master archival, bulk operations.

**Embed delivery.** Static HTML generated per video, uploaded to CDN, served from `embed.yourdomain.com`. Regenerated on metadata or customization change. Never rendered by the control plane at request time.

**Cache.** Tenant resolution and permission sets are read on every request. Cache both.

**Flows**

- *Provision:* create org, enqueue job, provider `createTenantSpace`, store encrypted creds, seed system groups, assign a plan, assign subdomain, activate.
- *Upload:* browser requests creds, `requirePermission('video.upload')`, `createAsset`, `getUploadCredentials`, browser uploads direct to provider, parallel copy of master to cold storage.
- *Encode complete:* provider webhook, `verifyWebhook`, normalized event, idempotent status update, enqueue embed generation.
- *Playback:* client site loads your embed page from CDN, your player calls `getPlaybackSources` for a resolved manifest, HLS streams from the provider CDN. Beacon posts to your analytics endpoint. Zero control-plane hops for the video itself.

---

## 9. Data model

```sql
provider_accounts
  id, provider text, label, credentials_encrypted,
  zone_count_cached, max_zones, accepting_new_tenants bool, created_at

organizations
  id uuid pk, name, slug unique, status,
  tier enum('dedicated','pooled'),
  provider text default 'bunny', provider_account_id fk,
  provider_space_id text,              -- library id / bucket prefix
  provider_space_meta jsonb,           -- cdn hostname, collection id, keys ref
  plan_id fk, plan_overrides jsonb,        -- per-org entitlement exceptions
  subdomain text unique, custom_domain text unique null,
  custom_domain_verified_at, settings jsonb, created_at, updated_at

plans
  id, key text unique, name, description,
  is_active bool, sort, created_at

plan_entitlements
  plan_id fk, entitlement_key text, value jsonb,   -- bool flag or numeric limit
  primary key(plan_id, entitlement_key)

org_customization        -- workspace customization, NOT a full brand
  id, organization_id fk unique,
  logo_url, logo_dark_url,                  -- shown alongside product identity
  player_accent, player_control_fg, player_control_bg,
  player_watermark_url, player_watermark_position,
  poster_style jsonb, updated_at

users            -- Better Auth owns these tables; extend, don't fork
  id, email, name, is_super_admin bool default false,
  last_active_org_id fk null, created_at

permissions
  key text pk, label, category, description

groups
  id, organization_id fk, name, description, is_system bool, created_at
  unique(organization_id, name)

group_permissions
  group_id fk, permission_key fk, primary key(group_id, permission_key)

memberships
  id, user_id fk, organization_id fk, group_id fk,
  status enum('invited','active','suspended'), invited_by, joined_at
  unique(user_id, organization_id)

folders
  id, organization_id fk, parent_id self fk null, name,
  provider_collection_id null, sort, created_at

videos
  id uuid pk,                              -- YOUR id, used in embed URLs
  organization_id fk, folder_id fk null,
  provider text, provider_asset_id text,   -- never exposed publicly
  master_storage_key text null, master_archived_at null,
  title, description, tags text[],
  status enum('created','uploading','processing','ready','error'),
  duration_seconds, width, height, storage_size_bytes,
  thumbnail_url, poster_override_url null,
  visibility enum('private','unlisted','public'),
  captions jsonb, created_at, updated_at, encoded_at
  index(organization_id, created_at desc)
  index(provider, provider_asset_id)

playback_events            -- first-party beacon, append-only
  id bigserial, organization_id fk, video_id fk,
  session_id uuid, event enum('load','play','progress','pause','ended'),
  position_seconds int, watched_seconds int,
  referrer text, country, device_type, user_agent_hash,
  viewer_key text null,    -- set when identity is known
  created_at
  index(organization_id, video_id, created_at)

analytics_rollups
  id, organization_id fk, video_id fk null, period_start date,
  granularity enum('hour','day'),
  plays bigint, unique_sessions bigint, watch_time_seconds bigint,
  completion_rate numeric, country_breakdown jsonb,
  referrer_breakdown jsonb, device_breakdown jsonb, computed_at
  unique(organization_id, video_id, period_start, granularity)

audit_log
  id, organization_id fk null, actor_user_id fk, acting_as_super_admin bool,
  action, target_type, target_id, metadata jsonb, ip, created_at

webhook_events
  id, organization_id fk null, provider, provider_asset_id,
  event_type, raw_payload jsonb, signature_valid bool, processed_at, created_at
```

Every tenant-scoped table carries `organization_id`. Add Postgres row-level security as a second layer so a missing WHERE clause fails closed. Cheap insurance against the one bug that ends a client relationship.

---

## 10. Feature requirements

### MVP (Phase 1)

**F1. Tenant provisioning.** Super admin creates a company; a job provisions the provider space, assigns the plan, seeds system groups, assigns a subdomain. *Accept:* usable within 60s; partial failure retries; never leaves a half-provisioned org; correct provider account selected by remaining capacity.

**F2. Auth and tenant resolution.** Better Auth sign-in; middleware resolves tenant from domain/subdomain/path; multi-org users get a switcher. *Accept:* a user with no membership in the resolved tenant gets 404, not 403.

**F3. Permission engine.** Seeded catalog, system groups, `requirePermission` on every mutating route and data query. *Accept:* permission changes take effect within cache TTL; no endpoint reachable without an explicit check.

**F4. Custom groups.** Create, rename, delete groups; toggle permissions. *Accept:* system groups editable but not deletable; last holder of `group.manage` cannot lock themselves out; deleting a group requires reassigning members.

**F5. Member management.** Invite by email using the product-branded template, assign group, remove, suspend. *Accept:* invite links expire; acceptance creates membership atomically.

**F6. Workspace customization.** Org uploads a logo and sets player accent, control colors, and an optional video watermark, with live preview. Gated by plan entitlement. *Accept:* saving regenerates that org's embeds within one job cycle; contrast validation blocks unreadable player colors; uploaded assets are normalized and size-capped; the application's own theme is untouched.

**F6b. Plans and entitlements.** Seeded plan catalog, per-org plan assignment, `requireEntitlement` guard alongside `requirePermission`. *Accept:* gated UI is hidden and gated endpoints reject server-side; limit-type entitlements (storage, users, bandwidth) are enforced at the point of action with a clear message, not silently.

**F7. Upload.** Resumable browser-to-provider upload with progress and resume, driven by `getUploadCredentials`. Master copied to cold storage. *Accept:* a 2 GB upload survives a network drop; provider keys never reach the browser.

**F8. Webhook ingest.** Signature-verified per space, normalized through the adapter, idempotent. *Accept:* replays do not double-process; invalid signatures rejected and logged.

**F9. Video library.** List, search, sort, filter by folder, edit metadata, delete, move, set thumbnail. *Accept:* every query tenant-scoped; search never crosses tenants.

**F10. Folders.** Create, rename, nest.

**F11. Embed system.** Your-domain embed URL, your player, responsive wrapper, lazy-load facade, VideoObject JSON-LD. *Accept:* copied code renders on an external page with zero requests to the control plane; no provider hostname appears anywhere in the output.

**F12. First-party analytics.** Beacon from the player, rollup job, dashboards showing plays, unique sessions, watch time, completion rate, top referrers, countries, devices. *Accept:* beacons batched (fire on play, pause, ended, and unload, not per second); tenant sees only their own data.

### Phase 2

Custom domains with automated TLS (plan-gated). Per-org email sender name on invitations. Signed playback tokens and expiring links. Per-tenant referrer allow-lists. Caption upload and management. Custom poster images. Bulk actions. Video replace. Audit log UI. Per-tenant usage and cost dashboard. Engagement graph from beacon data.

### Phase 3

Deeper player theming beyond tokens. CTAs and lead-gate forms. Chapters editor. Heatmaps. A/B testing. DRM toggle. SAML SSO via WorkOS. Public API with per-tenant keys and outbound webhooks. Pooled tier. Second provider adapter.

---

## 11. Screens

**Platform admin.** Tenants list with plan, tier, provider, storage, egress, status. Plan and entitlement management. Tenant detail and impersonation. Create-tenant wizard. Provider capacity dashboard. Global video search. Platform settings and secrets. Audit log. Cost and usage overview.

**Tenant app.** Branded login. Home with recent videos and stats. Video library with folder tree, search, filters. Upload. Video detail with preview, metadata, embed code, stats. Folders. Members. Groups and permissions editor. Workspace customization editor with live preview. Org settings. Analytics.

---

## 12. Non-functional requirements

**Performance.** p95 dashboard under 400ms warm. Tenant resolution plus permission check under 20ms cached. Embed page is static CDN HTML; player initialization under 200ms to first frame request.

**Isolation.** Physical (dedicated provider space) plus logical (`organization_id` everywhere) plus RLS. Tenant derived from session and host, never a client parameter. Cross-tenant attempts logged and alerted.

**Security.** Provider credentials encrypted at rest, never plaintext env vars once multi-tenant. Webhooks signature-verified per space. Super-admin impersonation audit-logged, banner-flagged, and gated behind a reason string. Rate-limit upload-credential, token, and beacon endpoints per tenant.

**Reliability.** Jobs retry with backoff and a dead-letter queue. Provisioning idempotent and resumable. Nightly Postgres backup with PITR. Reconciliation job verifies every `videos` row still exists at the provider and flags drift.

**Cost guardrails.** Per-tenant egress tracked and surfaced. Alert on threshold breach. Storage and delivery attributable per tenant for billback.

**Portability.** All provider calls behind `lib/providers/`. All auth behind `lib/auth/`. No Replit-specific APIs. Standard Postgres. Control plane relocatable to Fly or Render in a weekend.

---

## 13. Build sequence

| # | Step | Effort |
|---|---|---|
| 1 | Scaffold Next.js, Postgres, pooler, Better Auth | 1d |
| 2 | Schema, migrations, seed permission catalog | 1d |
| 3 | Tenant middleware: host resolution and request context | 0.5d |
| 4 | RBAC engine: groups, permissions, guard, caching | 1.5d |
| 5 | Job queue (pg-boss) and worker | 0.5d |
| 6 | **Provider adapter interface + Bunny implementation** | 2d |
| 7 | Tenant provisioning job | 1d |
| 8 | Plans and entitlements, workspace customization, token injection | 2d |
| 9 | Upload: credential endpoint, resumable client, master archival | 2d |
| 10 | Webhook receiver: verify, normalize, idempotent | 1d |
| 11 | **Player wrapper (hls.js/Vidstack) + embed page generator** | 3d |
| 12 | Video library UI | 2d |
| 13 | Folders | 0.5d |
| 14 | Members and invitations | 1d |
| 15 | Groups editor UI | 1d |
| 16 | Beacon endpoint, rollup job, analytics dashboards | 2.5d |
| 17 | Platform admin: tenants, capacity, impersonation, audit | 1.5d |
| 18 | Hardening: RLS, rate limits, reconciliation, error states | 1.5d |

**About 25 focused days.** Steps 1 through 11 are load-bearing; do not reorder. Steps 6 and 11 implement the portability rules P1 through P4 and are the two most important in the document. Each step is a self-contained Replit Agent prompt.

---

## 14. Open questions

1. Custom domains in Phase 1 or Phase 2? Biggest DNS and TLS complexity jump.
2. Will you bill tenants? If yes, usage attribution must be exact from day one.
3. Realistic tenant count in year one? Under 20 means Tier B and C scaffolding stays as columns only, no code.
4. Does any client need SSO? Price WorkOS in before you promise it.
5. Cold storage target: Backblaze B2 or Cloudflare R2? R2 doubles as a candidate future primary provider.
6. Root domain for tenant subdomains. Needed for the wildcard DNS record and cert, though it can be a placeholder during development since it is config, not code.

---

## 15. Honest risk list

**This is a month of focused work, not a week.** Custom RBAC, per-tenant branding, domain routing, provider abstraction, a self-owned player, and a beacon pipeline are each real subsystems. A stripped-down version using Bunny's iframe, Clerk's default roles, and no branding could ship in about a week. The extra three weeks buy portability and multi-tenant scale. That is the right trade if you are onboarding many companies and want the freedom to change providers. It is the wrong trade if year one is five clients and you are certain about Bunny. Be honest with yourself about which one you are in before starting.

**Steps 6 and 11 are where the value is.** They implement P1 through P4. If time pressure forces cuts, cut features (F10 folders, F12 analytics depth), never the adapter or the player wrapper. Those two are the only things that cannot be retrofitted cheaply.

**The 500-zone ceiling is real but distant.** Do not build the pooled tier now. Do put `tier`, `provider`, and `provider_account_id` in the schema now, because retrofitting them across live tenants is a painful migration.

**Customization is where clients will nickel-and-dime you.** The scoped model in section 7 is the defense: logo, player colors, watermark, and eventually a custom embed domain. Say no to application reskinning, layout changes, and custom navigation. Every yes there multiplies your QA surface permanently. Plan gating also gives you a commercial answer instead of a flat no.

**Super-admin impersonation is a liability.** Client libraries may hold confidential material. Banner it, log it, require a reason.

**Writing your own player has ongoing cost.** Browser and codec quirks are real, and you own them now instead of Bunny. Budget a day a quarter for maintenance. Use a maintained library (Vidstack or Video.js), never a from-scratch implementation.
