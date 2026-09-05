---
name: Dependency release evidence
description: Distinguishes source lockfile remediation from installed dependency acceptance.
---

A remediated lockfile is not sufficient release evidence when its package
archives have not been installed; require a clean frozen install, coherent
build, and audit of that installed graph.

**Why:** Offline lockfile resolution can select patched versions using cached
metadata even when their archives are absent. A later offline install can fail
mid-relink, so a clean source audit alone can overstate runtime readiness.

**How to apply:** When registry access is unavailable or prohibited, keep the
safe source resolution, restore a coherent cached development install if
necessary, and report package installation plus post-install scans as an
explicit release gate.