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
| 3. Functions deploy | Disabled by repository variable | Explicit five-function allowlist only |
| 4. Cursor Automation trigger | Requires one-time Cursor GitHub connection | Issues labeled `cloud-agent` |
| 5. Stable unattended operation | Enabled after successful staging trials | ChatGPT → GitHub → Cloud Agent → Actions |

## Repository controls

- `AGENTS.md` controls all coding agents.
- `.cursor/rules/lkc-staging-safety.mdc` makes the Cursor rule always active.
- `scripts/automation/validate-staging-scope.mjs` rejects any project, region,
  service, function, confirmation, or branch outside the allowlist.
- `.github/workflows/release-candidate.yml` is the one canonical full CI. The
  automation work does not create a duplicate PR verification workflow.
- `.github/workflows/staging-cloud-run-invoker.yml` separates read-only
  diagnosis from the two-service mutation.
- `.github/workflows/staging-functions-deploy.yml` remains fail-closed until
  `LKC_STAGING_DEPLOY_ENABLED=true` is deliberately added after Phase A passes.

## One-time GCP bootstrap

Run `scripts/automation/bootstrap-github-wif.sh` from an authenticated Google
Cloud Shell only after this automation PR is merged. It:

- accepts only `lip-knots-crew-staging`;
- creates separate observer and deployer service accounts;
- trusts only this immutable GitHub repository ID and owner ID;
- trusts only `main`;
- trusts only the two staging workflow filenames;
- creates no JSON service-account key;
- grants a small custom Cloud Run role for Invoker IAM check management;
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

During the first successful trials, configure both with a required reviewer.
Do not add deployment branches other than `main`.

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
7. Run a single allowlisted staging Functions deployment and review the result.

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

