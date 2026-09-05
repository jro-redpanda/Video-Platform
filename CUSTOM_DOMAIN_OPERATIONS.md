# Custom-domain ownership operations

Create a domain through the workspace API, then publish the returned exact TXT value at
the returned TXT name. Request verification after DNS propagation. A verified state proves
DNS ownership only; it returns `external_setup_required` because TLS certificates, CDN/edge
host routing, and traffic activation are deliberately external integration work.

`pending_verification`, `verifying`, `verified`, `failed`, `suspended`, and
`reconciliation_required` are durable states. Failed checks use capped backoff; suspended
claims require a new request or operator action. Reconciliation-required claims are not
automatically retried. The worker repair scan republishes eligible durable work after a
crash. A request cannot replace an in-flight worker claim, and requests made before the
persisted retry time do not consume the broader verification-rate budget. Removal
immediately disables the local claim and revokes its challenge. Removal remains available
after a plan downgrade, but challenge details and new verification requests do not.

Hostnames are ASCII/IDN normalized and reject URLs, ports, IPs, wildcards, the application
domain, and private or reserved naming suffixes. Claims are globally exclusive while
active. TXT challenge values are returned only to entitled managers while ownership setup
is incomplete; verified and downgraded responses redact them, and audits always omit them.

Ownership verification intentionally checks only the exact TXT challenge. It neither
requires nor trusts A/AAAA records because this application does not activate or connect
to custom-domain traffic. A future TLS/edge integration must resolve addresses at every
connection boundary, reject private and special-use destinations after every redirect or
DNS refresh, and must not treat this ownership status as an SSRF or routing authorization.

Branding object keys are internal storage identifiers and are not accepted or returned by
the workspace API. Logo and watermark upload, validation, normalized variants, and delivery
remain unimplemented rather than accepting an unsafe client-supplied object reference.