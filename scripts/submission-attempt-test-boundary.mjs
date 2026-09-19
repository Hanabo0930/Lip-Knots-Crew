// 画面の既存試験では端末保存だけを境界化する。保存/ハッシュ本体は別試験で実行する。
export const syntheticSubmissionRequestId='11111111-1111-4111-8111-111111111111';
export const submissionAttemptBoundary={draftKey:'synthetic-draft',loadSubmissionAttempt:async()=>({prepareSubmissionAttempt:async(_key,files)=>({clientRequestId:syntheticSubmissionRequestId,storageKey:'synthetic-attempt',contentHashes:files.map(()=> 'a'.repeat(64))}),clearSubmissionAttempt:()=>{}})};
