# Staging Hosting unattended release

## Goal

Remove Cloud Shell and local Cursor from routine Staff/Admin Hosting releases
while preserving a deliberate human approval before live staging changes.

The default `evidence_policy=source-provenance` retains the strict deployed-source
gate. The explicitly reviewed `limited-staff-pilot` policy follows
[the limited Staff acceptance procedure](LIMITED_STAFF_HOSTING_ACCEPTANCE.md).
It records an unauthenticated staging trial separately from Staff acceptance and
retains backup/preview channels until acceptance; the normal cleanup sequence
below does not apply to that policy.

For missing retained Build hashes, the separately reviewed
[fixed-generation source route](STAGING_FIXED_SOURCE_REVIEW.md) uses
`evidence_policy=source-provenance`, manual
`source_acquisition=fixed-source-once` and the exact acquisition confirmation
`ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB`. It bounds one source acquisition to
two 10 MiB ZIPs / 12 GETs using the existing identity. It keeps the same current
main, CI, Preview, protected environment, backup, per-POST verification and
rollback requirements. Default/automatic runs still use retained evidence.
This requires no new WIF, role, credential or long-lived resource. Source/code
mismatch stops before Hosting changes; source acquisition success is separate
from authenticated app or business acceptance.

## Fixed release path

1. A pull request is approved and merged to `main`.
2. `Release Candidate Checks` runs three independent lanes:
   web/release regressions, Functions tests, and security/automation guards.
3. A successful current `main` run triggers `Staging Hosting Preview`.
4. The preview workflow uses Node 22 and locked dependencies, discovers the two
   staging Hosting sites, and rebuilds only Staff/Admin.
5. Firebase creates one-day preview channels.
6. Playwright opens both preview URLs in Chromium and rejects:
   blank roots, boot exceptions, failed scripts/styles, demo mode, non-200
   documents, or navigation slower than 12 seconds.
7. GitHub stores screenshots and JSON evidence for 14 days.
8. `Staging Hosting Promote` requires the current successful `main` SHA, the
   exact typed confirmation, the enable switch, and the protected environment.
9. Both current live versions are cloned to rollback channels.
10. The exact preview versions are cloned to live without rebuilding.
11. Playwright checks both live sites again.
12. A partial clone or failed live check restores both rollback channels and
    fails the workflow.

## Cloud scope

Allowed:

- project `lip-knots-crew-staging`;
- Hosting targets `staff` and `admin`;
- expiring preview/rollback channels;
- live staging promotion after approval.

Prohibited:

- Functions, Firestore, Storage, Rules, IAM, organization policy, or production
  changes from either Hosting workflow;
- application branches as deployment sources;
- long-lived Google service-account keys;
- rebuilds between preview validation and live promotion;
- automatic pull-request merge.

## One-time configuration

Re-run `scripts/automation/bootstrap-github-wif.sh` from an authenticated owner
session after this change is merged. The script updates the existing WIF
provider to trust the two Hosting workflow filenames and grants
`roles/firebasehosting.admin` to the staging deploy identity.

In GitHub:

1. Create environment `lkc-staging-hosting`.
2. Add the owner as required reviewer.
3. Restrict deployment branches to `main`.
4. Add `LKC_STAGING_HOSTING_PREVIEW_ENABLED=true`.
5. Add `LKC_STAGING_HOSTING_PROMOTE_ENABLED=true`.

Site IDs and Firebase client configuration are discovered automatically. Add
the optional site/VAPID variables documented in `UNATTENDED_AUTOMATION.md` only
if automatic discovery stops safely.

## Evidence

Preview artifacts retain:

- Firebase channel deployment JSON;
- `channel-metadata.json`, normalized from Staff/Admin `hosting:channel:list`:
  the exact site/channel resource, preview URL, expiry time/status, full version
  resource name, version status, and `versionConfirmed`;
- Staff/Admin screenshots;
- browser result JSON with HTTP status, root mount, navigation duration, page
  errors, fatal console errors, and static-resource failures.

Promotion artifacts additionally retain backup, promotion, live-check, and
rollback evidence. Configuration values, tokens, credentials, complete IAM
policies, email addresses, and application data are not written to evidence.

Channel metadata retains only these allowlisted fields, not the raw list
responses. Missing version names stay `null` with `versionConfirmed=false`;
short IDs are never expanded. Only a full version name for the selected site
with status `FINALIZED` sets `versionConfirmed=true`. Expiry is reported
separately as `ACTIVE`, `EXPIRED`, or `UNCONFIRMED` (missing expiry). These are
observations at capture time, not approval or source-provenance evidence.
The promotion, pilot, backup, and recovery requirements remain unchanged.
