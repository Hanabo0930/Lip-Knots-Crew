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

echo "DEPLOY_PROJECT=$lkc_project"
echo "DEPLOY_REGION=$lkc_region"
echo "DEPLOY_FUNCTIONS=$lkc_functions"
echo "DEPLOY_HOSTING=false"
echo "DEPLOY_RULES=false"
echo "DEPLOY_FIRESTORE=false"
echo "DEPLOY_STORAGE=false"

lkc_trusted_runner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-staging-firebase-deploy.cjs"
export LKC_PROJECT_ID="$lkc_project" LKC_REGION="$lkc_region" LKC_SOURCE_REF="$lkc_source_ref"
export LKC_FUNCTIONS="$lkc_functions" LKC_CONFIRMATION="$lkc_confirmation" LKC_SOURCE_DIRECTORY="$lkc_source_directory"
npx --yes --package=firebase-tools@15.24.0 -- node "$lkc_trusted_runner"

for function_name in "${function_names[@]}"; do
  service_name=""
  case "$function_name" in
    loginGateway) service_name="logingateway" ;;
    bootstrapSession) service_name="bootstrapsession" ;;
    requestStaffLoginLink) service_name="requeststaffloginlink" ;;
    getSubmissionTimeline) service_name="getsubmissiontimeline" ;;
    getSubmissionProcessingStatus) service_name="getsubmissionprocessingstatus" ;;
    getResubmissionComparison) service_name="getresubmissioncomparison" ;;
    driveFilePreview) service_name="drivefilepreview" ;;
    createUploadSession) service_name="createuploadsession" ;;
    finalizeStagedUpload) service_name="" ;;
    retrySafeSheetWrites) service_name="" ;; # 専用runnerで認証・停止・Schedulerを照合済み
    registerDeviceSession) service_name="registerdevicesession" ;;
    heartbeatDeviceSession) service_name="heartbeatdevicesession" ;;
    listMyDevices) service_name="listmydevices" ;;
    revokeMyDevice) service_name="revokemydevice" ;;
    revokeAllMyDevices) service_name="revokeallmydevices" ;;
    getStaffDevices) service_name="getstaffdevices" ;;
    adminRevokeStaffDevices) service_name="adminrevokestaffdevices" ;;
    registerPushToken) service_name="registerpushtoken" ;;
    unregisterPushToken) service_name="unregisterpushtoken" ;;
    getPushStatus) service_name="getpushstatus" ;;
    sendTestPush) service_name="sendtestpush" ;;
    processNotificationQueue) service_name="" ;;
    confirmApplication) service_name="confirmapplication" ;;
    createResubmissionRequest) service_name="createresubmissionrequest" ;;
    getMyResubmissionRequests) service_name="getmyresubmissionrequests" ;;
    getAdminResubmissionRequests) service_name="getadminresubmissionrequests" ;;
    completeResubmissionRequest) service_name="completeresubmissionrequest" ;;
    getExpenseReview) service_name="getexpensereview" ;;
    saveExpenseReviewDraft) service_name="saveexpensereviewdraft" ;;
    completeExpenseReview) service_name="completeexpensereview" ;;
    getJobSheetLink) service_name="getjobsheetlink" ;;
    markNetPrintPrinted) service_name="marknetprintprinted" ;;
    adminCancelJob) service_name="admincanceljob" ;;
    duplicateAdminJob) service_name="duplicateadminjob" ;;
    applyToJob) service_name="applytojob" ;;
    getMyTasks) service_name="getmytasks" ;;
    listMyMailApplications) service_name="listmymailapplications" ;;
    setSalesFloorClientSubmitted) service_name="setsalesfloorclientsubmitted" ;;
    submitPreContact) service_name="submitprecontact" ;;
    inspectSetupWizard) service_name="inspectsetupwizard" ;;
    saveSetupWizardDraft) service_name="savesetupwizarddraft" ;;
    getLoginInviteCandidates) service_name="getlogininvitecandidates" ;;
    sendLoginInvites) service_name="sendlogininvites" ;;
    previewMonthSheetCreation) service_name="previewmonthsheetcreation" ;;
    createMonthSheetSafe) service_name="createmonthsheetsafe" ;;
    getMonthCreationHistory) service_name="getmonthcreationhistory" ;;
    previewSheetRowCreation) service_name="previewsheetrowcreation" ;;
    listSheetWriteReviewRecords) service_name="listsheetwritereviewrecords" ;;
    runGasAudit) service_name="rungasaudit" ;;
    scanGasUploadSafety) service_name="scangasuploadsafety" ;;
    submitPilotOutcome) service_name="submitpilotoutcome" ;;
    decidePilotExpansion) service_name="decidepilotexpansion" ;;
    getPilotReadiness) service_name="getpilotreadiness" ;;
    getPilotExpansionReview) service_name="getpilotexpansionreview" ;;
    getProductionControlStatus) service_name="getproductioncontrolstatus" ;;
    getProductionSloDashboard) service_name="getproductionslodashboard" ;;
    exportGasAuditMarkdown) service_name="exportgasauditmarkdown" ;;
    getAutomationRegistry) service_name="getautomationregistry" ;;
    saveAutomationRegistry) service_name="saveautomationregistry" ;;
    cancelAutomationRegistryAttempt) service_name="cancelautomationregistryattempt" ;;
    listHeldMailApplications) service_name="listheldmailapplications" ;;
    getHeldMailApplication) service_name="getheldmailapplication" ;;
    recheckHeldMailApplication) service_name="recheckheldmailapplication" ;;
    cancelHeldMailApplicationReview) service_name="cancelheldmailapplicationreview" ;;
    previewCaseMailCampaignRegistration) service_name="previewcasemailcampaignregistration" ;;
    registerCaseMailCampaign) service_name="registercasemailcampaign" ;;
    cancelCaseMailCampaignRegistration) service_name="cancelcasemailcampaignregistration" ;;
    getCaseMailImportSnapshot) service_name="getcasemailimportsnapshot" ;;
    listAutomationNoticeReceipts) service_name="listautomationnoticereceipts" ;;
    getAutomationNoticeHandoff) service_name="getautomationnoticehandoff" ;;
    receiveCaseMailApplication) service_name="receivecasemailapplication" ;;
    receiveAutomationNoticeReceipt) service_name="receiveautomationnoticereceipt" ;;
    previewStaffImport) service_name="previewstaffimport" ;;
    syncStaffDirectoryReadOnly) service_name="syncstaffdirectoryreadonly" ;;
    previewShiftImport) service_name="previewshiftimport" ;;
    syncShiftSheetsReadOnly) service_name="syncshiftsheetsreadonly" ;;
    retrySheetWriteIssue) service_name="retrysheetwriteissue" ;;
    acknowledgeSheetWriteIssue) service_name="acknowledgesheetwriteissue" ;;
    getSheetWriteIssues) service_name="getsheetwriteissues" ;;
    getOperationsDashboard) service_name="getoperationsdashboard" ;;
    getStaffPerformance) service_name="getstaffperformance" ;;
    createAdminJobGroup) service_name="createadminjobgroup" ;;
    updateJobPublication) service_name="updatejobpublication" ;;
    adminEditJobInputs) service_name="admineditjobinputs" ;;
    generateJobExport) service_name="generatejobexport" ;;
    updateNetPrintNumbers) service_name="updatenetprintnumbers" ;;
    adminSetJobCancellation) service_name="adminsetjobcancellation" ;;
    adminRestoreCancelledJob) service_name="adminrestorecancelledjob" ;;
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
