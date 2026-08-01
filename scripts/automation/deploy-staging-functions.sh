#!/usr/bin/env bash
set -euo pipefail

lkc_project="${LKC_PROJECT_ID:-lip-knots-crew-staging}"
lkc_region="${LKC_REGION:-asia-northeast1}"
lkc_source_ref="${LKC_SOURCE_REF:-main}"
lkc_functions="${LKC_FUNCTIONS:-}"
lkc_confirmation="${LKC_CONFIRMATION:-}"
lkc_source_directory="${LKC_SOURCE_DIRECTORY:-}"

node scripts/automation/validate-staging-scope.mjs \
  --mode functions-deploy \
  --project "$lkc_project" \
  --region "$lkc_region" \
  --source-ref "$lkc_source_ref" \
  --functions "$lkc_functions" \
  --confirmation "$lkc_confirmation"

if [[ -z "$lkc_source_directory" || ! -f "$lkc_source_directory/firebase.json" ]]; then
  echo "DEPLOY_RESULT=FAIL"
  echo "DEPLOY_ERROR=SOURCE_DIRECTORY_INVALID"
  exit 1
fi

IFS=',' read -r -a function_names <<< "$lkc_functions"
only_targets=()
for function_name in "${function_names[@]}"; do
  only_targets+=("functions:${function_name}")
done
only_csv="$(IFS=,; echo "${only_targets[*]}")"

echo "DEPLOY_PROJECT=$lkc_project"
echo "DEPLOY_REGION=$lkc_region"
echo "DEPLOY_FUNCTIONS=$lkc_functions"
echo "DEPLOY_HOSTING=false"
echo "DEPLOY_RULES=false"
echo "DEPLOY_FIRESTORE=false"
echo "DEPLOY_STORAGE=false"

(
  cd "$lkc_source_directory"
  npx --yes firebase-tools@15.24.0 deploy \
    --only "$only_csv" \
    --project "$lkc_project" \
    --non-interactive
)

for function_name in "${function_names[@]}"; do
  service_name=""
  case "$function_name" in
    bootstrapSession) service_name="bootstrapsession" ;;
    requestStaffLoginLink) service_name="requeststaffloginlink" ;;
    getSubmissionTimeline) service_name="getsubmissiontimeline" ;;
    getSubmissionProcessingStatus) service_name="getsubmissionprocessingstatus" ;;
    getResubmissionComparison) service_name="getresubmissioncomparison" ;;
    driveFilePreview) service_name="drivefilepreview" ;;
    finalizeStagedUpload) service_name="" ;;
    listMyDevices) service_name="listmydevices" ;;
    *)
      echo "DEPLOY_RESULT=FAIL"
      echo "DEPLOY_ERROR=UNMAPPED_FUNCTION_AFTER_GUARD"
      exit 1
      ;;
  esac

  if [[ -n "$service_name" ]]; then
    gcloud run services update "$service_name" \
      --no-invoker-iam-check \
      --project "$lkc_project" \
      --region "$lkc_region" \
      --quiet

    forbidden="$(
      gcloud run services get-iam-policy "$service_name" \
        --project "$lkc_project" \
        --region "$lkc_region" \
        --format=json \
        | node -e '
          let input = "";
          process.stdin.on("data", (chunk) => input += chunk);
          process.stdin.on("end", () => {
            const document = JSON.parse(input);
            const denied = new Set(["allUsers", "allAuthenticatedUsers"]);
            const found = (document.bindings ?? []).some((binding) =>
              (binding.members ?? []).some((member) => denied.has(member))
            );
            process.stdout.write(found ? "true" : "false");
          });
        '
    )"
    if [[ "$forbidden" == "true" ]]; then
      echo "DEPLOY_RESULT=FAIL"
      echo "DEPLOY_ERROR=FORBIDDEN_PUBLIC_IAM_BINDING_FOUND"
      exit 1
    fi
  fi
done

echo "DEPLOY_RESULT=SUCCESS"
echo "PRODUCTION_TOUCHED=false"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Staging Functions deploy"
    echo
    echo "- Project: \`$lkc_project\`"
    echo "- Source ref: \`$lkc_source_ref\`"
    echo "- Functions: \`$lkc_functions\`"
    echo "- Hosting/Rules/Firestore/Storage: \`not deployed\`"
    echo "- Production: \`not touched\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
