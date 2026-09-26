# Staging worker migration

This dedicated path updates one existing worker per run through the protected
`lkc-staging-deploy` environment. The ordinary Functions deployment allowlist
continues to reject these six workers. No workflow is dispatched automatically.

Targets: processSafeSheetWrite, updateExpenseReviewFromQueue,
dispatchDueNotifications, scheduleOperationalReminders,
processSheetRowCreation, retrySheetRowCreation.

## Required review

Scope permission is not evidence of quiescence. Before deployment, an independent
review must establish arrival control (including HTTP/direct writers), completion
of old executions and external writes, recovery of retained events, and a durable
backup of the existing fixed source/configuration. Never manufacture the clearance
from timeouts, absent logs, HTTP 200, a new revision, or the inspection result.

`clearance_json` has schemaVersion 1, the exact project/region/target/sourceSha,
issuedAt/expiresAt with timezone (at most two hours), reviewedBy (GitHub handle),
and beforeSha256 from an inspection of the final maintenance configuration.
Its `evidence` object contains SHA-256 digests of independently reviewed private
records: arrivalControl, oldExecutionCompletion, externalEffectsCompletion,
retainedEventRecovery, sourceBackup. Its `confirmed` object explicitly records
newArrivalsHeld, oldExecutionsFinished, externalEffectsSettled,
retainedEventsRecoverable as true. Hashes and booleans do not prove the underlying
facts. The protected-environment reviewer must inspect the actual private records.
Do not approve this environment automatically unless all those facts are verified.

The supported live gate requires the two existing scheduled jobs to remain PAUSED,
the three Eventarc transport subscriptions to have empty pushConfig and at least
48 hours retention, and authenticated worker invocation. These operations are
**not performed or authorized by this workflow**. Holding delivery, extending
retention, controlling other arrivals and resuming/replaying retained messages
require a separately approved maintenance plan. Existing 24-hour push delivery
fails this gate. Retention duration alone does not establish that older messages
will survive: message age and the recovery deadline belong in the reviewed plan.
No production, original-sheet writes, real notifications, business document
updates, queue replay, Rules or IAM changes are authorized here.

## Execution

Run `Staging Worker Migration` on the exact current CI-passing main, initially in
`inspect` mode, with confirmation `MIGRATE_LKC_STAGING_WORKER_PAUSED`.
Inspection reads configuration only, reports a digest and the first blocker,
and never certifies execution completion or deployment readiness.
Deploy requires a reviewed clearance for that exact digest and commit.

The source archive includes built lib, TypeScript sources, package.json,
tsconfig.json and the checked-in case-mail runtime. Environment files and
node_modules are excluded. The runner uses generateUploadUrl and a single
Functions v2 PATCH with updateMask restricted to buildConfig.source and
serviceConfig.environmentVariables. Existing environment values are preserved;
sheet-write and notification modes are set to paused. Trigger, Scheduler,
Pub/Sub and IAM APIs are read-only. The missing notification Scheduler is never
created. The completed retry recovery and other workers are not redeployed.

Before PATCH, current configuration and clearance expiry are checked again.
Afterward, the fixed-generation source archive from sourceProvenance is downloaded
and compared file by file with the uploaded archive (the permanent bucket differs
from the upload bucket). Revision, configuration, traffic, triggers, subscriptions,
Scheduler and IAM are checked. A failure or unknown outcome stops without
repeating PATCH, resuming delivery or rolling back to the old code. Read the
operation/current resources before deciding any next action.

Private metadata stays in the runner's temporary directory and is not uploaded.
Only sanitized status/digests go to the job summary. The separately reviewed
durable backup remains mandatory; the temporary snapshot does not replace it.

References:
- [Functions update mask](https://docs.cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/patch)
- [Source upload](https://docs.cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/generateUploadUrl)
- [Pub/Sub delivery hold](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/modifyPushConfig)
