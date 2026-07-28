# Lip Knots Crew agent guardrails

These rules apply to every automated coding agent working in this repository.

## Fixed environment

- The only deployable project in unattended workflows is `lip-knots-crew-staging`.
- The only allowed region is `asia-northeast1`.
- Production access, production deploys, and production credentials are prohibited.
- Never print secrets, access tokens, ID tokens, environment files, personal data, or complete cloud resource policies.

## Git safety

- Work on a dedicated `cursor/*` or `automation/*` branch.
- Never push directly to `main`.
- Never merge a pull request automatically.
- Never rewrite shared history or use destructive Git commands.
- Keep unrelated changes out of the current task.

## Allowed autonomous work

- Read repository state and pull-request context.
- Edit source, tests, documentation, and workflow files within the requested scope.
- Run `npm ci`, scoped builds, and repository tests.
- Create or update a dedicated branch and draft pull request.
- Report results through GitHub checks and pull-request comments.

## Cloud safety

The only Functions allowed in the first unattended staging deployment phase are:

- `bootstrapSession`
- `getSubmissionTimeline`
- `getSubmissionProcessingStatus`
- `getResubmissionComparison`
- `driveFilePreview`
- `finalizeStagedUpload`

Never use `firebase deploy --only functions`. Every Functions deployment must list
each function explicitly and pass `scripts/automation/validate-staging-scope.mjs`.
The source branch must also pass
`scripts/automation/check-deploy-source-integrity.mjs`; workflow files,
Firebase configuration, dependency manifests, environment files, and automation
guards cannot be changed by the deployment source branch.

The only Cloud Run services whose Invoker IAM check may be changed are:

- `getsubmissionprocessingstatus`
- `drivefilepreview`

Do not add or remove `allUsers` or `allAuthenticatedUsers` IAM bindings. Do not
change organization policy, project-wide IAM, Firestore data, Storage data,
Rules, or any resource outside the explicit allowlist.

The only Hosting targets allowed in unattended workflows are:

- `hosting:staff`
- `hosting:admin`

Hosting automation must use `.github/workflows/staging-hosting-preview.yml` and
`.github/workflows/staging-hosting-promote.yml`. A successful canonical CI run
on `main` may create expiring preview channels. Live staging promotion must:

- use the exact versions already validated in preview channels;
- require `PROMOTE_LKC_STAGING_HOSTING`;
- pass the protected `lkc-staging-hosting` environment;
- back up both current live channels before changing either;
- automatically restore both backups if promotion or post-promotion browser
  checks fail.

Never deploy Hosting directly from an application branch, rebuild during
promotion, or deploy Functions, Firestore, Storage, Rules, IAM, or production
from a Hosting workflow.

## Stop conditions

Stop without expanding scope when:

- the project, region, branch, function, or service differs from the allowlist;
- app-level authentication or authorization checks are missing;
- the effective Invoker IAM policy cannot be determined;
- a required GitHub check is not successful;
- a Hosting promotion does not reference the current CI-passing `main` commit;
- a Hosting preview cannot recover the current public Firebase client config;
- the required Hosting backup channels cannot be created;
- a cloud command fails for a reason not explicitly handled by the workflow;
- a deploy would require production access, a long-lived key, or a broader IAM role.

## Completion report

Every agent result must state:

- `SCOPE`
- `FILES_CHANGED`
- `CHECKS_RUN`
- `CHECKS_RESULT`
- `DEPLOY_PERFORMED`
- `CLOUD_RESOURCES_CHANGED`
- `BLOCKERS`
- `NEXT_SAFE_ACTION`
