# Upload API source refresh: review required before cloud writes

## Observed result, 2026-10-31

The user approved cancelling unexecuted waiting run #515 and one additional
readiness-only config diagnostic. #515/run41178803940 completed/cancelled.
#516/run41179821406 ran once at main
`825c48f163741cae9915d39a964772bd5250c0aa`, through the existing protected review.
The config-diagnostic collector completed 10 GET and 2,758,448 source bytes.
The verifier stopped with `DEPLOYED_PACKAGE_INCOMPLETE`: the first Function,
`createUploadSession`, lacks 76 files required by the current built package.

The artifact is 13034053917, 1,224 bytes, SHA256
`036f813838078cdb63f160d3d575dc5b7b76a884f3baaa45b2bdde2e62bf89cf`.
Its bounded diagnostic has 16 path hashes and `truncated=true`. All 16 match
current tracked source paths or predictable TypeScript output paths, including
`src/case-list-publication-worker.ts`, `src/case-list-monthly-controller.cjs`,
`lib/case-list-recruitment.js`, and cancellation-related output. This is evidence
of missing required source/runtime files, rather than just optional packaging.
The other 60 paths were not disclosed by the bounded result. The second archive's
inventory/content and both archives' config-value comparisons were not reached.
Do not infer that every case-list Function is undeployed from an upload API's
source package, or claim config equality/paused verification.

All Hosting writes and rollback steps were skipped; private-source/key cleanup
succeeded. This consumed the newly approved attempt. Total real acquisitions
are three (#510, #513, #516). No additional acquisition or rerun is approved.

## Fix within the existing deployment preparation

`materialize-staging-transfer-mode.mjs` formerly converted a missing observed
mode into `active` while handling `preserve`. It also used the finalizer's
observation when deploying `createUploadSession` alone. With one shared dotenv,
different API modes could therefore be silently collapsed to one value.

The helper now reads each selected upload API's own bounded metadata. Preserve
requires an ACTIVE Function with the exact project/region/name/revision and a
recognized observed mode for each selected API. Missing modes and disagreement
between a selected pair stop before dotenv append. Entry-only preparation uses
the entry's own state. Explicitly requested switches retain the existing narrow
scope/source-control checks. This code change does not change runtime settings,
grant deployment approval, or prove that both deployed modes are paused.

Tests cover selected-API routing, missing/invalid observations, disagreement in
both argument orders, unchanged dotenv on rejection, and actual CLI subprocess
errors with private error text redacted. Other deployments do not acquire upload
metadata. No alternate business writer or deployment workflow is added.

## Remaining repair belongs in the existing Functions deployment route

Target proposal: only the existing `createUploadSession` and
`finalizeStagedUpload`, project `lip-knots-crew-staging`, region
`asia-northeast1`, using a current CI-passing main package. Keep the route in
`staging-functions-deploy.yml` and its current protected environment/identity.
Do not deploy a list of 76 Functions; 76 is a missing file count for the first
package. Keep the source-provenance gate strict.

The existing general deployment path is not ready to run as a source-only
repair. Its dotenv step replaces 15 values from GitHub settings before adding
transfer mode, and its deploy shell changes the entry service's Invoker check.
The new preserve fix does not provide full configuration preservation, original
source/config backup, or verified pair restoration.

Before proposing an actual cloud execution:

1. Capture fresh official revisions, pinned source generations, complete private
   configuration, and effective authentication settings for the exact pair.
   Bind before-images to the run/source identity; stop on uncertainty or drift.
2. Establish and verify exact source/config backups in a specifically reviewed
   private destination with existing access. Never publish config/source values
   as artifacts or add IAM to make a backup succeed.
3. Complete configuration-preserving preparation in the same owner route. Keep
   notification, sheet-write, and submission-transfer modes paused; no legacy
   fallback or automatic activation. Any intended setting difference must be
   shown before execution. Do not silently change Invoker authentication.
4. Implement and test failure of either update, ambiguous operation outcomes,
   and verified restoration of the pair. Do not retry unknown cloud mutations.
5. Pass exact-head formal CI, normal merge, and the existing protected review.
   Verify full packages, configuration preservation, paused flags, unchanged
   authentication and unauthenticated rejection after the limited update.
6. Then use normal Hosting provenance verification/publication and app login.
   GAS's previously scoped two files plus one private property remain conditional
   on app reflection/authentication. Real business acceptance is still separate.

## Approval boundary and impact

The user's current approval is a read-only diagnostic; it is not approval to
update Functions, write source/config backups, change settings, or publish.
The actual source-refresh implementation and private backup destination still
need to be completed/reviewed before requesting deployment approval. A future
concrete proposal must enumerate the two Functions, managed revisions/builds,
backup writes, preservation rules, restoration behavior and possible costs.
No Production, original shift-sheet writes, real email, new Functions/workers,
IAM/Rules changes or release of paused modes belongs in this repair.
