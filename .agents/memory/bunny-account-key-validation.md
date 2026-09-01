---
name: Bunny account-key validation
description: How to distinguish the Bunny global account credential needed for live provider verification.
---

The Step 6 live round trip requires a Bunny global account API key accepted by the core `api.bunny.net` library API. A Stream library key, read-only key, storage password, pull-zone key, or tus signature is not interchangeable.

**Why:** Multiple secret confirmations still produced Bunny's explicit `authentication.failed` response before any disposable library could be created. Retrying without independently validating that the stored value changed does not add information.

**How to apply:** Before rerunning the full encode test, have the account owner replace the workspace secret from Bunny's account-level API settings and verify the global key is authorized for the core video-library API. Never print, log, fingerprint, or persist the key outside workspace secrets.