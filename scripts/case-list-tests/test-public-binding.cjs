const assert=require('node:assert/strict');
// Reuse the actual pure-module loader so its shared publication barrier is
// loaded too; these identity assertions still use the production helpers.
const core=require('./test-worker-binding.cjs').load('sheet-write-core'),book='synthetic_private_source_book';
const job={companyId:'company-synthetic',caseId:'LKCASE_00000000-0000-5000-8000-000000000001',assignedStaffId:'staff-1',assignedStaffName:'合成担当',dateKey:'2026-11-20',workDate:'2026-11-20',revision:4,caseListSource:{bindingHash:'a'.repeat(64)},sheetRef:{sheetId:1773116117,sheetName:'2026.11',caseIdColumn:'BC',bindingHash:'b'.repeat(64)}};
const hydrated={...job,sheetRef:{...job.sheetRef,spreadsheetId:book}};
assert.equal(core.cancellationSheetWriteIdentity(job),core.cancellationSheetWriteIdentity(hydrated));
assert.equal(core.submissionSheetWriteIdentity(job),core.submissionSheetWriteIdentity(hydrated));
assert.equal(core.cancellationSheetWriteIdentity(hydrated).includes(book),false);
const legacy={...hydrated};delete legacy.caseListSource;assert.equal(core.cancellationSheetWriteIdentity(legacy).includes(book),true);
console.log(JSON.stringify({status:'PASS',tests:4,scope:'ACTUAL_EXISTING_IDENTITY_HELPERS_WITH_SYNTHETIC_DATA',nativeWrites:0}));
