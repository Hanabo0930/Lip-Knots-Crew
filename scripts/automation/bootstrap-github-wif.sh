#!/usr/bin/env bash
set -euo pipefail

lkc_project="lip-knots-crew-staging"
lkc_region="asia-northeast1"
lkc_repository="Hanabo0930/Lip-Knots-Crew"
lkc_repository_id="1301135145"
lkc_repository_owner_id="305317827"
lkc_pool_id="lkc-github-staging"
lkc_provider_id="lkc-main-workflows"
lkc_observer_account="lkc-gh-staging-observer"
lkc_deploy_account="lkc-gh-staging-deploy"
lkc_custom_role="lkcStagingInvokerManager"
lkc_confirmation="${LKC_CONFIRM_BOOTSTRAP:-}"

if [[ "$lkc_confirmation" != "BOOTSTRAP_LKC_STAGING_WIF" ]]; then
  echo "BOOTSTRAP_RESULT=STOPPED_SAFELY"
  echo "BOOTSTRAP_ERROR=CONFIRMATION_REQUIRED"
  exit 1
fi

active_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "$active_project" != "$lkc_project" ]]; then
  echo "BOOTSTRAP_RESULT=STOPPED_SAFELY"
  echo "BOOTSTRAP_ERROR=WRONG_ACTIVE_PROJECT"
  exit 1
fi

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
if [[ -z "$active_account" ]]; then
  echo "BOOTSTRAP_RESULT=STOPPED_SAFELY"
  echo "BOOTSTRAP_ERROR=NO_ACTIVE_GCLOUD_ACCOUNT"
  exit 1
fi

project_number="$(gcloud projects describe "$lkc_project" --format='value(projectNumber)')"
observer_email="${lkc_observer_account}@${lkc_project}.iam.gserviceaccount.com"
deploy_email="${lkc_deploy_account}@${lkc_project}.iam.gserviceaccount.com"

gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project "$lkc_project" \
  --quiet

if ! gcloud iam service-accounts describe "$observer_email" --project "$lkc_project" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$lkc_observer_account" \
    --project "$lkc_project" \
    --display-name "LKC GitHub staging observer"
fi

if ! gcloud iam service-accounts describe "$deploy_email" --project "$lkc_project" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$lkc_deploy_account" \
    --project "$lkc_project" \
    --display-name "LKC GitHub staging deployer"
fi

if ! gcloud iam workload-identity-pools describe "$lkc_pool_id" \
  --project "$lkc_project" \
  --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$lkc_pool_id" \
    --project "$lkc_project" \
    --location global \
    --display-name "LKC GitHub staging"
fi

attribute_mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref"
attribute_condition="assertion.repository_id=='${lkc_repository_id}' && assertion.repository_owner_id=='${lkc_repository_owner_id}' && assertion.ref=='refs/heads/main' && (assertion.workflow_ref=='${lkc_repository}/.github/workflows/staging-cloud-run-invoker.yml@refs/heads/main' || assertion.workflow_ref=='${lkc_repository}/.github/workflows/staging-functions-deploy.yml@refs/heads/main' || assertion.workflow_ref=='${lkc_repository}/.github/workflows/staging-hosting-preview.yml@refs/heads/main' || assertion.workflow_ref=='${lkc_repository}/.github/workflows/staging-hosting-promote.yml@refs/heads/main')"

if gcloud iam workload-identity-pools providers describe "$lkc_provider_id" \
  --project "$lkc_project" \
  --location global \
  --workload-identity-pool "$lkc_pool_id" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$lkc_provider_id" \
    --project "$lkc_project" \
    --location global \
    --workload-identity-pool "$lkc_pool_id" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "$attribute_mapping" \
    --attribute-condition "$attribute_condition"
else
  gcloud iam workload-identity-pools providers create-oidc "$lkc_provider_id" \
    --project "$lkc_project" \
    --location global \
    --workload-identity-pool "$lkc_pool_id" \
    --display-name "LKC trusted main workflows" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "$attribute_mapping" \
    --attribute-condition "$attribute_condition"
fi

principal_set="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${lkc_pool_id}/attribute.repository_id/${lkc_repository_id}"
for service_account in "$observer_email" "$deploy_email"; do
  gcloud iam service-accounts add-iam-policy-binding "$service_account" \
    --project "$lkc_project" \
    --member "$principal_set" \
    --role roles/iam.workloadIdentityUser \
    --quiet
done

for role_name in roles/run.viewer roles/cloudfunctions.viewer roles/orgpolicy.policyViewer; do
  gcloud projects add-iam-policy-binding "$lkc_project" \
    --member "serviceAccount:${observer_email}" \
    --role "$role_name" \
    --condition=None \
    --quiet
done

invoker_permissions="run.services.create,run.services.get,run.services.getIamPolicy,run.services.setIamPolicy,run.services.update,run.operations.get"
if gcloud iam roles describe "$lkc_custom_role" --project "$lkc_project" >/dev/null 2>&1; then
  gcloud iam roles update "$lkc_custom_role" \
    --project "$lkc_project" \
    --title "LKC staging Invoker IAM manager" \
    --description "Only the Cloud Run permissions required by the allowlisted staging workflows" \
    --permissions "$invoker_permissions" \
    --stage GA
else
  gcloud iam roles create "$lkc_custom_role" \
    --project "$lkc_project" \
    --title "LKC staging Invoker IAM manager" \
    --description "Only the Cloud Run permissions required by the allowlisted staging workflows" \
    --permissions "$invoker_permissions" \
    --stage GA
fi

for role_name in \
  roles/cloudfunctions.developer \
  roles/firebasehosting.admin \
  roles/firebase.viewer \
  roles/serviceusage.serviceUsageConsumer \
  "projects/${lkc_project}/roles/${lkc_custom_role}"; do
  gcloud projects add-iam-policy-binding "$lkc_project" \
    --member "serviceAccount:${deploy_email}" \
    --role "$role_name" \
    --condition=None \
    --quiet
done

declare -A service_accounts=()
for function_name in \
  bootstrapSession \
  requestStaffLoginLink \
  getSubmissionTimeline \
  getSubmissionProcessingStatus \
  getResubmissionComparison \
  driveFilePreview \
  finalizeStagedUpload; do
  runtime_account="$(gcloud functions describe "$function_name" \
    --gen2 \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --format='value(serviceConfig.serviceAccountEmail)')"
  if [[ -n "$runtime_account" ]]; then
    service_accounts["$runtime_account"]=1
  fi

  build_account="$(gcloud functions describe "$function_name" \
    --gen2 \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --format='value(buildConfig.serviceAccount)')"
  if [[ -n "$build_account" ]]; then
    build_account="${build_account##*/}"
    service_accounts["$build_account"]=1
  fi
done

for service_account in "${!service_accounts[@]}"; do
  gcloud iam service-accounts add-iam-policy-binding "$service_account" \
    --project "$lkc_project" \
    --member "serviceAccount:${deploy_email}" \
    --role roles/iam.serviceAccountUser \
    --quiet
done

provider_resource="projects/${project_number}/locations/global/workloadIdentityPools/${lkc_pool_id}/providers/${lkc_provider_id}"

echo "BOOTSTRAP_RESULT=SUCCESS"
echo "PROJECT_ID=$lkc_project"
echo "ACTIVE_ACCOUNT=$active_account"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=$provider_resource"
echo "GCP_STAGING_OBSERVER_SERVICE_ACCOUNT=$observer_email"
echo "GCP_STAGING_DEPLOY_SERVICE_ACCOUNT=$deploy_email"
echo "LONG_LIVED_SERVICE_ACCOUNT_KEY_CREATED=false"
echo "PRODUCTION_TOUCHED=false"
echo "NEXT_ACTION=Add the three printed GCP values as GitHub repository Actions variables."
