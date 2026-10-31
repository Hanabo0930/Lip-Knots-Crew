# Upload source refresh in the existing Functions owner route

## Current implementation and observed blocker

Readiness #516/run41179821406 at main
`825c48f163741cae9915d39a964772bd5250c0aa` stopped before publication with
`DEPLOYED_PACKAGE_INCOMPLETE`. The first createUploadSession package lacked
76 required files. Only 16 missing-path hashes were disclosed. The remaining
60 names, second package, and both private configuration comparisons were not
reached. This is a file count, not a deployment list of 76 Functions.

PR254 fixed the existing transfer helper's missing-value-to-active fallback and
entrypoint/finalizer observation mix-up. The diagnostic approval is consumed:
three actual acquisitions (#510, #513, #516), no further acquisition approved.
Neither this code nor a successful local test is approval to execute cloud writes.

The source refresh is now implemented inside the existing
`staging-functions-deploy.yml` -> `deploy-staging-functions.sh` ->
`run-staging-firebase-deploy.cjs` owner route. No new workflow, business writer,
Function, Scheduler, or alternate upload deployment entrypoint is added. The old
generic Firebase/Invoker-changing path rejects either upload Function. Other
Functions retain their existing deployment path.

## Exact operation to review

- Workflow: Staging Functions Deploy, branch main; operation
  `upload-source-refresh`; source_ref main; functions
  `createUploadSession,finalizeStagedUpload`; transfer_mode preserve;
  confirmation `REFRESH_LKC_STAGING_UPLOAD_SOURCE_PRESERVE`.
- Project `lip-knots-crew-staging`, project number `740154137290`, region
  `asia-northeast1`; exact CI-passing source SHA, first run attempt only.
- Existing enable switch, canonical CI, authorization/source checks, deployment
  concurrency group and `lkc-staging-deploy` protected review remain mandatory.
- No source-refresh dispatch or cloud execution has been performed for this code.

The workflow skips the GitHub-variable dotenv writer and transfer-mode writer for
this operation. It uses the same existing short-lived ADC/WIF identity, never
requests a new permission, and does not call the Firebase CLI's broader deploy
command. This is the sole upload update path in the existing owner runner.

## Preconditions before the first cloud write

Read complete official Function, Run service, Function/Run policies, Storage
event trigger, source-generation metadata, bucket settings and project policy.
Both Functions must be ACTIVE nodejs22, use their exact identities/revisions,
and have all traffic on the verified ready revision. Compare Function and Run
environment values. Notification, sheet-write and submission-transfer must all
be explicitly paused. Missing/active/acceptance states are not inferred or changed.

Secret references must use fixed numeric versions. Build's existing
GOOGLE_NODE_RUN_SCRIPTS must already disable automatic script execution.
Capture every setting privately; unknown configuration fields participate in
comparison and are not silently discarded.

The fixed existing bucket is
`gcf-v2-sources-740154137290-asia-northeast1`. Its current project, region,
uniform bucket-level access and enforced public-access prevention, plus private
bucket/project policies, must be observed. An unverified organization/folder
inheritance stops the operation. This code does not read outside the project,
create a bucket, alter its policy, or add IAM to make a backup succeed.
Actual bucket privacy, access and current paused values remain unverified until
an approved protected execution reads them.

## Bounded writes and preservation

Five direct, create-only GCS objects are proposed, always with
`ifGenerationMatch=0`:

| Objects | Fixed namespace | Bound |
| --- | --- | --- |
| Two current-source ZIPs | lkc-upload-source-refresh/RUN_ID/SOURCE_SHA/FUNCTION.zip | 10 MiB each, 20 MiB total |
| Two old-source copies | lkc-upload-source-backups/RUN_ID/SOURCE_SHA/FUNCTION.zip | 10 MiB each, 20 MiB total |
| Private before-image manifest | same backup prefix/before-images.json | 512 KiB |

Old ZIPs are copied server-side from the exact observed generation, with a source
generation precondition. Their raw bytes are not downloaded. Read back immutable
backup generations, sizes, MD5 and CRC32C before the first Function update.
The private manifest retains full configurations, identities and replacement
pins; it is not a GitHub artifact. Objects are retained; no deletion is included.

The source packages use the current strict readiness inventory, including runtime
JS, maps, TypeScript, CJS, current package manifests and approved packaging files.
A standalone Functions lock is checked against the existing canonical root lock
and installed in isolated CI without lifecycle scripts. No new dependency version
may be introduced by lock normalization. Private dotenv is checked against official
runtime values but never put in the new ZIP. Existing strict source provenance
therefore needs no dotenv exception or relaxed content/inventory check.

Update only `buildConfig.source` on each existing Function, sequentially.
Environment, secret references, runtime, service account, resource settings,
traffic, auth and Eventarc/Storage trigger fields are absent from the PATCH.
Normal provider builds/images/Run revisions and up to four managed canonical
source generations may accompany the two updates and, if necessary, two restores.
The operation does not directly update Run, IAM, Rules, triggers, schedulers or
business documents.

Google may retain the supplied immutable object or create the canonical
FUNCTION/function-source.zip generation. Bind the exact official resolved
generation to the local verified package bytes before accepting either result.
Fresh private comparisons must confirm preserved settings, policies, trigger
identity and paused flags. Only the entry Callable receives one unauthenticated
POST with a valid empty data envelope; 401/403 is required.
finalizeStagedUpload is a Storage event handler and is never HTTP-invoked.
The source bucket must differ from its submission event bucket.

## Failure and restoration

Backups, current snapshots and bucket policy must still agree before updates.
No write is retried after an unknown HTTP/operation outcome. Only read polling
of the same operation is allowed (up to ten minutes per operation).

For a known terminal failure, identify the attempted source using its exact pin
or verified provider checksum metadata. If settings/auth/trigger or an unowned
source have drifted, stop without overwriting them. Otherwise restore only
attempted updates in reverse order through the same source-only owner callback.
Use verified backup generations, not a possibly overwritten original object.
Verify both previous source payloads and settings, including any provider-created
canonical copy. Unknown/failed restoration stops the remaining writes.

Restoration verifies the previous source ZIP payload and configuration; rebuilding
an old source archive does not claim a byte-identical historical container image.
In particular an older archive may not have a standalone dependency lock.
An unverifiable degraded Run service remains held instead of being assumed safe.

Requests are bounded (700 authenticated resource requests, 16 MiB metadata,
two new-package media reads/20 MiB). There are at most five direct GCS creates,
two forward Function PATCHes and two restoration PATCHes. Source/config buffers
and temporary packages are cleaned. The only retained GitHub artifact is bounded
`upload-source-refresh-result.json`; no configs, ZIPs, credentials or policies.
Build, artifact storage and GCS charges may occur within this scope.

## Completion boundary

Code, isolated tests, formal CI, protected cloud execution, Hosting publication,
app login, conditional GAS reflection and real business acceptance are separate.
A local fake transport is explicitly marked isolated-test and cannot report a
real cloud deployment. This operation does not publish Hosting or authorize a
later acquisition. Normal Hosting provenance verification must still pass in its
existing route; its current acquisition budget requires separate explicit scope.
The fixed collector/evidence validators recognize only the legacy exact object or
this exact per-Function refresh namespace. Full pinned build/source, inventory,
content, timing, protected-context, byte and request checks remain in place.

The business order remains application/direct name entry -> president's client
name-up -> president's explicit selection -> monthly write/readback ACK ->
staff confirmed shift and internal calendar. ACK-before-confirmation, hidden
transferred/cancelled rows, private cancellation history, no automatic recruitment,
and all held unsupported cases retain their existing implementation and boundaries.

## Primary API contracts

- [Cloud Functions source field mask](https://docs.cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/patch)
- [GCS generation-precondition copy](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/copy)
- [GCS create-only upload](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert)
- [Run service metadata](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.services/get)
