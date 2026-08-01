# Lip Knots Crew unattended automation

## Outcome

The target operating model removes local Cursor Run/Accept prompts:

1. The owner sends the request to ChatGPT.
2. ChatGPT creates or updates a structured GitHub task.
3. Cursor Cloud Agent works on a dedicated branch and draft pull request.
4. GitHub Actions performs the canonical checks.
5. Approved staging workflows use short-lived Google credentials.
6. Results are collected in checks, job summaries, and the pull request.
7. Production and automatic merge remain disabled.

## Safety stages

| Stage | Status after this PR | Automatic scope |
|---|---|---|
| 0. Agent rules and CI | Ready | Source edits, tests, draft PR |
| 1. GCP read-only diagnosis | Requires one-time WIF bootstrap | Three Cloud Run services, no mutation |
| 2. Invoker IAM check fix | Manual workflow + typed confirmation + environment gate | Exactly two staging services |
| 3. Functions deploy | Disabled by repository variable | Explicit eight-function allowlist only; `bootstrapSession` is the safe default |
| 4. Hosting preview | Disabled until the Hosting bootstrap switch is enabled | Expiring Staff/Admin preview channels after successful `main` CI |
| 5. Hosting promotion | Typed confirmation + protected environment | Same tested versions to Staff/Admin live staging with automatic rollback |
| 6. Cursor Automation trigger | Requires one-time Cursor GitHub connection | Issues labeled `cloud-agent` |
| 7. Stable unattended operation | Enabled after successful staging trials | ChatGPT → GitHub → Cloud Agent → Actions |

## Repository controls

- `AGENTS.md` controls all coding agents.
- `.cursor/rules/lkc-staging-safety.mdc` makes the Cursor rule always active.
- `scripts/automation/validate-staging-scope.mjs` rejects any project, region,
  service, function, confirmation, or branch outside the allowlist.
- `scripts/automation/check-deploy-source-integrity.mjs` rejects deployment
  branches that alter workflows, Firebase configuration, dependency manifests,
  environment files, agent rules, or automation guards.
- `scripts/automation/check-function-auth-guards.mjs` requires server-side
  authentication and function-specific scope checks before deploy, including
  company-and-staff-scoped, bounded, read-only access for `listMyDevices`.
- `.github/workflows/release-candidate.yml` is the one canonical full CI. The
  automation work does not create a duplicate PR verification workflow.
- `.github/workflows/staging-cloud-run-invoker.yml` separates read-only
  diagnosis from the two-service mutation.
- `.github/workflows/staging-functions-deploy.yml` remains fail-closed until
  `LKC_STAGING_DEPLOY_ENABLED=true` is deliberately added after Phase A passes.
- `.github/workflows/staging-hosting-preview.yml` builds only Staff/Admin,
  creates one-day preview channels, and records real-browser screenshots.
- `.github/workflows/staging-hosting-promote.yml` clones the already-tested
  preview versions to live staging after approval; it never rebuilds.
- Both current live Hosting versions are cloned to rollback channels before
  promotion, and both are restored on any partial promotion or browser failure.

## One-time GCP bootstrap

Run `scripts/automation/bootstrap-github-wif.sh` from an authenticated Google
Cloud Shell only after this automation PR is merged. It:

- accepts only `lip-knots-crew-staging`;
- creates separate observer and deployer service accounts;
- trusts only this immutable GitHub repository ID and owner ID;
- trusts only `main`;
- trusts only the four staging workflow filenames;
- creates no JSON service-account key;
- grants a small custom Cloud Run role for Invoker IAM check management;
- grants Firebase Hosting Admin only to the staging deploy identity;
- discovers the deployed Functions runtime/build identities before granting
  `iam.serviceAccountUser`.

The script requires:

```bash
export LKC_CONFIRM_BOOTSTRAP=BOOTSTRAP_LKC_STAGING_WIF
bash scripts/automation/bootstrap-github-wif.sh
```

Add its three non-secret outputs as GitHub Actions repository variables:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_STAGING_OBSERVER_SERVICE_ACCOUNT`
- `GCP_STAGING_DEPLOY_SERVICE_ACCOUNT`

Do not create or upload a service-account JSON key.

## GitHub environment gates

Create these GitHub environments:

- `lkc-staging-iam`
- `lkc-staging-deploy`
- `lkc-staging-hosting`

During the first successful trials, configure all three with a required reviewer.
Do not add deployment branches other than `main`.

Add these repository Actions variables only after the environment protection and
WIF bootstrap are complete:

- `LKC_STAGING_HOSTING_PREVIEW_ENABLED=true`
- `LKC_STAGING_HOSTING_PROMOTE_ENABLED=true`

The workflow discovers the two Hosting sites and recovers Firebase's public web
configuration from the current staging deployment. Optional overrides exist for
unusual multi-site projects:

- `LKC_STAGING_STAFF_HOSTING_SITE`
- `LKC_STAGING_ADMIN_HOSTING_SITE`
- `LKC_STAGING_VAPID_KEY`

The VAPID value is a public browser key, not a private signing key. The preview
workflow first attempts to recover it from the current Staff bundle and stops
safely if it cannot find exactly one value.

## First execution order

1. Run `Staging Cloud Run Invoker` with `operation=diagnose`.
2. Confirm the reference service has Invoker IAM check disabled, both application
   authorization checks pass, and the effective policy does not require the
   check.
3. Run the same workflow with `operation=apply`, the exact typed confirmation,
   and the protected `lkc-staging-iam` approval.
4. Confirm both endpoints stop returning platform `403`, with no public IAM
   binding added.
5. Test authenticated preview and processing status in the Staff app.
6. Only then set `LKC_STAGING_DEPLOY_ENABLED=true`.
7. Run a single-function staging deployment for `bootstrapSession` and review
   the result before selecting any other allowlisted Function.
8. Set `LKC_STAGING_HOSTING_PREVIEW_ENABLED=true`; the next successful `main`
   CI run creates and checks an expiring Hosting preview automatically.
9. Review the Staff/Admin screenshots and run `Staging Hosting Promote` with
   the exact confirmation `PROMOTE_LKC_STAGING_HOSTING`.
10. Approve the protected `lkc-staging-hosting` environment. The workflow backs
    up both live sites, promotes the tested versions, re-checks both live apps,
    and automatically restores both backups on failure.

## Cursor Cloud Agent setup

Connect Cursor's GitHub integration to `Hanabo0930/Lip-Knots-Crew`, then create
one Cursor Automation that watches GitHub issues labeled `cloud-agent`.
The Automation must:

- read the issue and repository agent rules;
- create a dedicated `cursor/*` branch;
- open or update a draft pull request;
- never deploy or merge;
- stop when the requested scope conflicts with the repository rules.

Use `.github/ISSUE_TEMPLATE/cloud-agent-task.yml` for every unattended task.
Local Cursor is no longer part of the normal operating path after one Cloud
Agent task completes successfully.
