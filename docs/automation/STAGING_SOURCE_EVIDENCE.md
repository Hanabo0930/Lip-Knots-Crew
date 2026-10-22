# Retained source evidence for staging Hosting

The source-provenance route accepts an already-retained local bundle only after
an independent protected reviewer has pinned its exact SHA256. It never fetches
source bytes, starts a Build, or changes a Function. Missing inputs remain STOP.

## Trust and activation boundary

The existing `lkc-staging-hosting` protected job maps the independently reviewed
environment variable `LKC_STAGING_SOURCE_EVIDENCE_SHA256` to
`LKC_APPROVED_SOURCE_EVIDENCE_SHA256`. It must be 64 lowercase hex characters
computed over the exact UTF-8 `bundle.json` bytes. It is not a workflow-dispatch
input, a CLI option, or a field accepted from the bundle.

**A checksum chosen by the bundle producer does not establish authenticity.**
Before provisioning the independent pin, the protected reviewer must inspect
the original official Function/Build observations, their acquisition origin and
times, and the approved complete build inventory. Copying a submitted checksum,
`verified=true`, or a diagnostic `CONSISTENT` result is insufficient. The pin
is the trust boundary for retained observations; this code does not pretend
that unsigned JSON can cryptographically prove its own Google origin.

The bundle must already exist at `$RUNNER_TEMP/hosting-source-evidence`.
This change intentionally does not provision a pin or materialize any source
archive. A fresh hosted runner therefore remains STOP until an independently
reviewed, authorized retained-file delivery arrangement exists. Do not add a
GCS fallback, source downloader, credential, new OAuth scope, or extra-cost
override to make that condition pass. This is an explicit remaining operational
prerequisite, not a completed real-environment acceptance.

Production entry points require the fixed repository, main ref, promote job and
workflow, first run attempt, staging project/region, source-provenance policy,
non-metadata mode, matching source SHA and the existing operation confirmation.
Protected approval and all other workflow guards remain necessary.

## Bundle schema

No extra keys, duplicate JSON keys, secrets, environment variables, tokens,
personal data, arbitrary paths or caller verification flags are accepted.
Synthetic examples are generated only in `test-hosting-source-evidence.py`;
they are not real deployment records.

```text
bundle.json
  schemaVersion: 1
  projectId: lip-knots-crew-staging
  region: asia-northeast1
  sourceSha: exact current CI-passing main SHA
  expiresAt: RFC3339 UTC
  observations:
    before: {capturedAt, functions: {createUploadSession, finalizeStagedUpload}}
    builds: {capturedAt, records: {full referenced Build name: projected Build}}
    after: {capturedAt, functions: {createUploadSession, finalizeStagedUpload}}
  expectedInventory: {complete expected package path: normalized SHA256}
  archives:
    gs://fixed-bucket/fixed-object.zip#fixed-generation:
      file: local-basename.zip
      sha256: raw archive SHA256
```

The before/build/after capture times must be ordered, not in the future, and
the whole validity window must be at most ten minutes from the initial capture.
Expiry is checked again after content verification. Records that become stale
while the Functions build runs must be recaptured/reviewed through an authorized
route; the workflow does not extend their deadline.

Each Function record contains exactly:
- `name, environment, state, updateTime`
- `buildConfig.build, runtime, entryPoint`
- `buildConfig.sourceProvenance.resolvedStorageSource.{bucket,object,generation}`
- `serviceConfig.service, revision, allTrafficOnLatestRevision`

Both exact Function identities must be ACTIVE, GEN_2, nodejs22, use the exact
entrypoint/service, send all traffic to the verified revision, and remain equal
across the reviewed capture window. Fixed source generation is mandatory.

Each referenced Build record contains `id, projectId, status, createTime,
startTime, finishTime, sourceProvenance`, and optionally `name`. Its project,
region and complete Build ID must match the Function reference, status must be
SUCCESS, and its resolved Storage source must be identical. The hash map must
contain exactly this GCS archive (full gs URI, with or without generation in the
key); unknown forms STOP. The resolved generation is always required. Exactly
one canonical base64 SHA256 is required and must equal the actual retained ZIP
bytes. MD5 alone, image digests, unrelated map entries and inconsistent hashes
do not establish source identity.

`expectedInventory` must equal `expected_files()` from the exact approved
checkout/build: package.json, package-lock.json when present, complete lib JS,
src TS, and case-mail-runtime code/JSON. The existing archive inventory/content
validator is reused. A partial manifest, a Git source ZIP, or a passing synthetic
test cannot substitute for this comparison. Existing normalization of source
line endings is preserved; archive authenticity uses the raw byte SHA256.

Local files are bounded, basename-only, and must be regular files. Symlinks,
reparse points, hard links, traversal, duplicate archive paths, missing/extra
relevant code and changed bytes fail closed. No ZIP is extracted.

## Execution and results

The existing pre-auth `--no-fee-source-guard` invokes the local Python verifier
with `--preflight`. It validates the reviewed pin, observations, linked Build
hashes and retained bytes. `PREFLIGHT_READY` explicitly leaves
`deployedSourceVerified=false` and `hostingPromotionAuthorized=false`.

The existing post-build readiness step invokes the same CLI without preflight,
checks exact HEAD and complete approved inventory, then returns PASS only for
the source comparison. `hostingPromotionAuthorized=false` and
`authenticatedStaffAcceptance=UNVERIFIED` remain explicit. This does not
replace live version pins, backups/recovery, limited-pilot Auth/account review,
current-main checks, or protected environment approval.

The old implicit `gcloud functions describe` / `gcloud storage cat` defaults
and the now-unused setup-gcloud step are removed. The isolated `check()`
validator requires explicit test/adapter readers and is not the release CLI.
There is no remote fallback when the local bundle is missing.

## Validation

The existing Python readiness suite loads the synthetic source-evidence suite.
It covers the positive complete chain, separate pin/context, stale/future
records, deployment drift, wrong Build/generation/hash, archive tampering,
incomplete inventory, secret/extra/duplicate fields, filesystem boundaries,
CLI rejection and preserved workflow guards. The existing Node restore suite
also tests preflight subprocess success/failure and untrusted contexts.
Windows uses a simulated hard-link stat boundary where the sandbox denies
link creation; standard Linux CI tests a real hard link.

This implementation does not add, read or approve real evidence; update Auth;
change a cloud permission; invoke Functions; dispatch Actions; or approve or
perform a Hosting promotion.
