# Custom-domain ownership operations

Create a domain through the workspace API, then publish the returned exact TXT value at
the returned TXT name. Request verification after DNS propagation. A verified state proves
DNS ownership only; it returns `external_setup_required` because TLS certificates, CDN/edge
host routing, and traffic activation are deliberately external integration work.

`pending_verification`, `verifying`, `verified`, `failed`, `suspended`, and
`reconciliation_required` are durable states. Failed checks use capped backoff; suspended
claims require a new request or operator action. Reconciliation-required claims are not
automatically retried. The worker repair scan republishes eligible durable work after a
crash. Removal immediately disables the local claim and revokes its challenge.

Hostnames are ASCII/IDN normalized and reject URLs, ports, IPs, wildcard and private or
reserved names. Claims are globally exclusive while active. Audits intentionally omit TXT
challenge values.