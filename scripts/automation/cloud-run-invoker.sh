#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
lkc_project="${LKC_PROJECT_ID:-lip-knots-crew-staging}"
lkc_region="${LKC_REGION:-asia-northeast1}"
lkc_source_ref="${LKC_SOURCE_REF:-cursor/staging-preview-performance-20260724}"
lkc_confirmation="${LKC_CONFIRMATION:-}"

reference_service="getsubmissiontimeline"
blocked_services=("getsubmissionprocessingstatus" "drivefilepreview")
diagnostic_services=("$reference_service" "${blocked_services[@]}")

if [[ "$operation" != "diagnose" && "$operation" != "apply" ]]; then
  echo "OVERALL_RESULT=FAIL"
  echo "ERROR=OPERATION_NOT_ALLOWED"
  exit 1
fi

service_csv="$(IFS=,; echo "${diagnostic_services[*]}")"
if [[ "$operation" == "diagnose" ]]; then
  node scripts/automation/validate-staging-scope.mjs \
    --mode invoker-diagnose \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --source-ref "$lkc_source_ref" \
    --services "$service_csv"
else
  mutable_csv="$(IFS=,; echo "${blocked_services[*]}")"
  node scripts/automation/validate-staging-scope.mjs \
    --mode invoker-apply \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --source-ref "$lkc_source_ref" \
    --services "$mutable_csv" \
    --confirmation "$lkc_confirmation"
fi

annotation_value() {
  local service_name="$1"
  gcloud run services describe "$service_name" \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --format=json \
    | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const document = JSON.parse(input);
        const annotations = document?.metadata?.annotations ?? {};
        const value = annotations["run.googleapis.com/invoker-iam-disabled"];
        process.stdout.write(value === undefined ? "false" : String(value));
      });
    '
}

forbidden_binding_value() {
  local service_name="$1"
  gcloud run services get-iam-policy "$service_name" \
    --project "$lkc_project" \
    --region "$lkc_region" \
    --format=json \
    | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const document = JSON.parse(input);
        const forbidden = new Set(["allUsers", "allAuthenticatedUsers"]);
        const found = (document.bindings ?? []).some((binding) =>
          (binding.members ?? []).some((member) => forbidden.has(member))
        );
        process.stdout.write(found ? "true" : "false");
      });
    '
}

effective_policy_state() {
  local constraint_name="$1"
  local policy_json
  if ! policy_json="$(gcloud resource-manager org-policies describe "$constraint_name" \
    --project "$lkc_project" \
    --effective \
    --format=json 2>/dev/null)"; then
    echo "UNKNOWN"
    return
  fi
  POLICY_JSON="$policy_json" node -e '
    const document = JSON.parse(process.env.POLICY_JSON ?? "{}");
    const rules = document?.spec?.rules ?? [];
    if (rules.some((rule) => rule.enforce === true)) process.stdout.write("ENFORCED");
    else process.stdout.write("NOT_ENFORCED");
  '
}

reference_annotation="$(annotation_value "$reference_service")"
blocked_annotation_values=()
for service_name in "${blocked_services[@]}"; do
  blocked_annotation_values+=("$(annotation_value "$service_name")")
done

managed_policy="$(effective_policy_state "constraints/run.managed.requireInvokerIam")"
legacy_policy="$(effective_policy_state "constraints/run.requireInvokerIam")"

forbidden_bindings="false"
for service_name in "${diagnostic_services[@]}"; do
  if [[ "$(forbidden_binding_value "$service_name")" == "true" ]]; then
    forbidden_bindings="true"
  fi
done

same_pattern="false"
if [[ "$reference_annotation" == "true" ]]; then
  same_pattern="true"
fi

safe_to_apply="false"
if [[ "$same_pattern" == "true" \
  && "$managed_policy" == "NOT_ENFORCED" \
  && "$legacy_policy" != "ENFORCED" \
  && "$forbidden_bindings" == "false" ]]; then
  safe_to_apply="true"
fi

echo "REFERENCE_INVOKER_IAM_DISABLED=$reference_annotation"
echo "BLOCKED_SERVICES_INVOKER_IAM_DISABLED=${blocked_annotation_values[*]}"
echo "REQUIRE_INVOKER_IAM_POLICY=$managed_policy"
echo "LEGACY_REQUIRE_INVOKER_IAM_POLICY=$legacy_policy"
echo "FORBIDDEN_PUBLIC_IAM_BINDINGS=$forbidden_bindings"
echo "SAME_PATTERN_CONFIRMED=$same_pattern"
echo "SAFE_TO_DISABLE_INVOKER_IAM_CHECK=$safe_to_apply"
echo "EXACT_LIMITED_COMMANDS=gcloud run services update getsubmissionprocessingstatus --no-invoker-iam-check; gcloud run services update drivefilepreview --no-invoker-iam-check"
echo "SOURCE_FILES_CHANGED=false"

if [[ "$operation" == "apply" ]]; then
  if [[ "$safe_to_apply" != "true" ]]; then
    echo "OVERALL_RESULT=STOPPED_SAFELY"
    exit 1
  fi

  for service_name in "${blocked_services[@]}"; do
    gcloud run services update "$service_name" \
      --no-invoker-iam-check \
      --project "$lkc_project" \
      --region "$lkc_region" \
      --quiet
  done
fi

processing_status="$(
  curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
    --max-time 20 \
    --request POST \
    --header "Content-Type: application/json" \
    --data '{"data":{}}' \
    "https://${lkc_region}-${lkc_project}.cloudfunctions.net/getSubmissionProcessingStatus" \
    || echo "000"
)"
preview_status="$(
  curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
    --max-time 20 \
    "https://${lkc_region}-${lkc_project}.cloudfunctions.net/driveFilePreview" \
    || echo "000"
)"

echo "PROCESSING_STATUS_HTTP=$processing_status"
echo "DRIVE_PREVIEW_HTTP=$preview_status"

if [[ "$operation" == "apply" ]]; then
  post_apply_pass="true"
  for service_name in "${blocked_services[@]}"; do
    if [[ "$(annotation_value "$service_name")" != "true" ]]; then
      post_apply_pass="false"
    fi
    if [[ "$(forbidden_binding_value "$service_name")" == "true" ]]; then
      post_apply_pass="false"
    fi
  done
  if [[ "$processing_status" == "403" || "$preview_status" == "403" || "$post_apply_pass" != "true" ]]; then
    echo "OVERALL_RESULT=FAIL"
    exit 1
  fi
  echo "OVERALL_RESULT=SUCCESS"
else
  echo "OVERALL_RESULT=DIAGNOSIS_COMPLETE"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Cloud Run Invoker IAM check"
    echo
    echo "- Operation: \`$operation\`"
    echo "- Project: \`$lkc_project\`"
    echo "- Region: \`$lkc_region\`"
    echo "- Reference disabled: \`$reference_annotation\`"
    echo "- Managed policy: \`$managed_policy\`"
    echo "- Safe to apply: \`$safe_to_apply\`"
    echo "- Processing endpoint HTTP: \`$processing_status\`"
    echo "- Preview endpoint HTTP: \`$preview_status\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

