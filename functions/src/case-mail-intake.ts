import { resetApplicationConfirmation, assignmentPreparationPatch } from "./assignment-preparation-core";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { caseMailRecordKey } from "./case-mail-job-creation";
import { normalizeJobInput } from "./job-management-core";
import { hasCaseMailCollision } from "./case-mail-collision";
import { caseMailTargetHoldPatch } from "./case-mail-target-hold";
import { assertProductionOperational } from "./system-safety";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ConfigSchema = z.object({
  companyId: id, uid: id, producerId: id, principalRevision: id,
  mailbox: z.literal("info@lipknots.com"), startedAt: z.iso.datetime({ offset: true }),
}).strict();
const SourceSchema = z.object({
  partId: id, rowKey: z.string().min(1).max(500).regex(/^[^\r\n]+$/),
  unitIndex: z.number().int().min(0).max(99), sha256: hash,
}).strict();
const AnalysisSchema = z.object({
  messageId: id, sourceFingerprint: hash, receivedAt: z.iso.datetime({ offset: true }),
  state: z.enum(["ready", "review", "skipped"]), structuralComplete: z.boolean(),
  issues: z.array(z.string().max(500)).max(100),
  parts: z.array(z.object({ partId: id, sha256: hash }).strict()).max(500),
  candidates: z.array(z.object({
    source: SourceSchema, input: z.record(z.string(), z.unknown()),
    sourceValues: z.record(z.string(), z.unknown()), parserSource: z.record(z.string(), z.unknown()),
  }).strict()).max(200),
}).strict();
type Config = z.infer<typeof ConfigSchema>;
/** 内部ワーカー専用。取得と解析はサーバー配線の依存で、HTTP入力から指定できない。 */
export interface CaseMailProvider {
  fetch(request: { messageId: string; mailbox: string }): Promise<unknown>;
  parse(source: unknown, context: { companyId: string; startedAt: string }): unknown;
}
function fail(message: string): never { throw new HttpsError("failed-precondition", message); }
async function checkReceiver(tx: FirebaseFirestore.Transaction, config: Config) {
  const [principal, feature] = await Promise.all([
    tx.get(db.collection("automationIngestPrincipals").doc(caseMailRecordKey(config.companyId, config.uid))),
    tx.get(db.collection("companyFeatureSettings").doc(config.companyId)),
  ]);
  const current = principal.data();
  if (!current || current.companyId !== config.companyId || current.uid !== config.uid || current.active !== true ||
      current.producerId !== config.producerId || current.revision !== config.principalRevision) fail("受信実行者の会社・登録・確認版が一致しません。");
  if (feature.data()?.caseMailIntakeEnabled !== true) fail("メール受信保存は未有効です。");
}
export function createCaseMailReceiver(serverConfig: Config, provider: CaseMailProvider) {
  const config = ConfigSchema.parse(serverConfig);
  // 設定は認証済みサーバー実行環境から渡す。公開受付・スケジューラーはまだ配線しない。
  return async (request: unknown) => {
    const { messageId } = z.object({ messageId: id }).strict().parse(request);
    await assertProductionOperational(config.companyId);
    await db.runTransaction(tx => checkReceiver(tx, config));
    const fetched = await provider.fetch({ messageId, mailbox: config.mailbox });
    const analysis = AnalysisSchema.parse(provider.parse(fetched, { companyId: config.companyId, startedAt: config.startedAt }));
    if (analysis.messageId !== messageId) fail("取得したメールIDが依頼と一致しません。");
    if (analysis.state === "skipped" || Date.parse(analysis.receivedAt) < Date.parse(config.startedAt)) {
      return { status: "skipped", persisted: false, candidateIds: [] as string[] };
    }
    // 保存文書とtransactionの上限を超える原文は部分成功にしない。
    if (analysis.candidates.some(candidate => JSON.stringify(candidate).length > 8000)) fail("候補の保存サイズを確認してください。");
    const receiptId = caseMailRecordKey("case-mail-receipt", config.companyId, messageId);
    const receiptRef = db.collection("caseMailIntakeReceipts").doc(receiptId);
    const analysisHash = caseMailRecordKey(analysis);
    const candidateIds = analysis.candidates.map(candidate => caseMailRecordKey("case-mail-candidate",
      config.companyId, messageId, candidate.source.partId, candidate.source.rowKey, candidate.source.unitIndex));
    if (new Set(candidateIds).size !== candidateIds.length ||
        new Set(analysis.parts.map(part => part.partId)).size !== analysis.parts.length) fail("解析した出典位置が重複しています。");
    const issues = [...analysis.issues];
    const candidates = analysis.candidates.map(candidate => {
      const normalized = normalizeJobInput(candidate.input as unknown as Parameters<typeof normalizeJobInput>[0]);
      const input = normalized.value;
      const date = new Date(input.workDate + "T00:00:00Z");
      if (normalized.errors.length || input.slots !== 1 || input.basePay !== null ||
          input.publicationMode !== "draft" || input.publishAt !== null || input.workDate < "2026-10-01" ||
          !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input.workDate ||
          !analysis.parts.some(part => part.partId === candidate.source.partId && part.sha256 === candidate.source.sha256)) {
        issues.push("CANDIDATE_REVIEW");
      }
      return { ...candidate, input };
    });
    if (analysis.state !== "ready" || !analysis.structuralComplete || !candidates.length) issues.push("SOURCE_REVIEW");
    return db.runTransaction(async tx => {
      await checkReceiver(tx, config);
      const previous = (await tx.get(receiptRef)).data();
      if (previous) {
        if (previous.companyId !== config.companyId || previous.messageId !== messageId ||
            previous.ingestedBy !== config.uid || previous.producerId !== config.producerId ||
            previous.principalRevision !== config.principalRevision) fail("保存済み受信記録の会社・実行者が一致しません。");
        if ((previous.heldAnalysisHash ?? previous.analysisHash) === analysisHash) {
          return { receiptId, status: previous.status, revision: previous.revision,
            candidateIds: previous.candidateIds as string[], persisted: true, replayed: true };
        }
        // 原文変更・減枠・解析版変更は候補/案件内容を残し、既存募集だけを保留する。
        const revision = previous.revision + 1;
        const auditRef = db.collection("auditLogs").doc(caseMailRecordKey("case-mail-change", receiptId, revision));
        if ((await tx.get(auditRef)).exists) fail("受信変更の監査IDが重複しています。");
        if (!Array.isArray(previous.candidateIds) || previous.candidateIds.length > 200 || new Set(previous.candidateIds).size !== previous.candidateIds.length ||
            !Number.isSafeInteger(previous.revision) || previous.revision < 1 || previous.revision >= Number.MAX_SAFE_INTEGER) fail("受信変更の版・候補を確認してください。");
        const linked = await Promise.all(previous.candidateIds.map((candidateId: unknown) => tx.get(db.collection("caseMailIntakeCandidates").doc(id.parse(candidateId)))));
        const jobRefs = [];
        for (const snap of linked) {
          const candidate = snap.data();
          if (!candidate || candidate.companyId !== config.companyId || candidate.receiptId !== receiptId) fail("変更対象の候補を確認してください。");
          if (candidate.status === "linked") jobRefs.push({ ref: db.collection("jobs").doc(id.parse(candidate.linkedJobId)), candidateId: snap.id });
        }
        const jobs = await Promise.all(jobRefs.map(item => tx.get(item.ref)));
        for (const [index, snap] of jobs.entries()) {
          const job = snap.data();
          if (!job || job.companyId !== config.companyId || job.mailIntake?.receiptId !== receiptId || job.mailIntake?.candidateId !== jobRefs[index]!.candidateId ||
              !Number.isSafeInteger(job.revision) || job.revision < 0 || job.revision >= Number.MAX_SAFE_INTEGER) fail("変更対象の案件の対応・版を確認してください。");
        }

        const targetJobs: {ref:FirebaseFirestore.DocumentReference;job:FirebaseFirestore.DocumentData;hold:FirebaseFirestore.DocumentData}[]=[];
        for(const snap of linked){
          const binding=snap.data()?.targetBinding;
          if(binding===undefined)continue;
          if(binding.companyId!==config.companyId||binding.receiptId!==receiptId||binding.candidateId!==snap.id||
            !hash.safeParse(binding.reviewVersion).success)fail("別メールの対応記録を確認してください。");
          const jobRef=db.collection("jobs").doc(id.parse(binding.jobId));
          const [jobSnap,bindingAudit,holdAudit]=await tx.getAll(jobRef,
            db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target",config.companyId,receiptId,snap.id)),
            db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target-hold",config.companyId,receiptId,snap.id)));
          const job=jobSnap!.data();let hold=job?.mailTargetHold;
          if(!job||job.companyId!==config.companyId)fail("対応先の会社・案件を確認してください。");
          const resolved=snap.data()?.targetResolution;
          if(hold==null&&resolved){
            const releaseAudit=(await tx.get(db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target-resolution",config.companyId,receiptId,snap.id,previous.revision,previous.heldAnalysisHash??previous.analysisHash)))).data();
            if(resolved.version!==1||resolved.companyId!==config.companyId||resolved.receiptId!==receiptId||resolved.candidateId!==snap.id||
              resolved.jobId!==jobRef.id||resolved.receiptRevision!==previous.revision||resolved.analysisHash!==(previous.heldAnalysisHash??previous.analysisHash)||
              resolved.bindingVersion!==binding.reviewVersion||releaseAudit?.companyId!==config.companyId||releaseAudit.action!=="caseMail.target.resolve"||
              JSON.stringify(releaseAudit.resolution)!==JSON.stringify(resolved)||!resolved.hold)fail("解除済みの受信と監査の対応を確認してください。");
            hold={...resolved.hold,previousReviewRequired:job.mailIntakeReviewRequired===true};
          }
          if(hold==null)continue;
          if(hold.receiptId!==receiptId||hold.candidateId!==snap.id){
            if(resolved)fail("別メールの保留中です。先に現在の依頼を確認してください。");
            continue;
          }
          if(hold.version!==1||hold.receiptRevision!==previous.revision||hold.analysisHash!==(previous.heldAnalysisHash??previous.analysisHash)||!["change","cancel"].includes(hold.kind)||
            hold.companyId!==config.companyId||hold.jobId!==binding.jobId||hold.bindingVersion!==binding.reviewVersion||
            !Number.isSafeInteger(job.revision)||job.revision<0||job.revision>=Number.MAX_SAFE_INTEGER||
            bindingAudit!.data()?.companyId!==config.companyId||bindingAudit!.data()?.action!=="caseMail.target.confirm"||
            JSON.stringify(bindingAudit!.data()?.binding)!==JSON.stringify(binding)||
            holdAudit!.data()?.companyId!==config.companyId||holdAudit!.data()?.action!=="caseMail.target.hold"||
            holdAudit!.data()?.jobId!==binding.jobId||holdAudit!.data()?.reviewVersion!==binding.reviewVersion||holdAudit!.data()?.kind!==hold.kind)fail("別メールの保留と監査の対応を確認してください。");
          if(targetJobs.some(item=>item.ref.id===jobRef.id)||jobs.some(item=>item.id===jobRef.id))fail("保留対象の案件が重複しています。");
          targetJobs.push({ref:jobRef,job,hold});
        }
        const now = Timestamp.now();
        for(const item of targetJobs)tx.set(item.ref,caseMailTargetHoldPatch(item.job,{...item.hold,receiptRevision:revision,analysisHash,requestedAt:now},now),{merge:true});
        for (const snap of jobs) {
          const job = snap.data()!;
          tx.set(snap.ref, { publishable: false, recruitmentStopped: true, scheduledPublishAt: FieldValue.delete(),
            status: job.cancelled === true || job.status === "cancelled" ? "cancelled" : job.assignedStaffId || job.status === "assigned" ? "assigned" : job.status === "draft" ? "draft" : "stopped",
            ...assignmentPreparationPatch(job, { ...job, mailIntakeReviewRequired: true, revision: job.revision + 1 }),
            mailIntakeReviewRequired: true, mailIntakeHold: { receiptId, revision, analysisHash }, preContactNeedsReview: true, preContactLate: false, mailPublication: FieldValue.delete(), assignmentSheetWrite: null, ...resetApplicationConfirmation(), revision: job.revision + 1, updatedAt: now }, { merge: true });
        }
        for (const snap of linked) {
          const position = candidateIds.indexOf(snap.id), incoming = position < 0 ? null : candidates[position]!;
          tx.set(snap.ref, { heldChange: { revision, analysisHash, input: incoming?.input ?? null, valid: incoming != null && !issues.includes("CANDIDATE_REVIEW") }, updatedAt: now }, { merge: true });
        }
        tx.set(receiptRef, { status: "review", revision, heldAnalysisHash: analysisHash, reviewRequestedAt: now,
          heldSourceFingerprint: analysis.sourceFingerprint, heldCandidateCount: candidates.length, heldStructuralComplete: analysis.structuralComplete,
          issues: ["SOURCE_CHANGED", ...(candidateIds.length !== previous.candidateIds.length || candidateIds.some(candidateId => !previous.candidateIds.includes(candidateId)) ? ["SOURCE_STRUCTURE_CHANGED"] : [])], updatedAt: now }, { merge: true });
        tx.set(auditRef, { companyId: config.companyId, actorUid: config.uid, action: "caseMail.intake.review",
          detail: { receiptId, revision, reason: "SOURCE_CHANGED" }, createdAt: now });
        return { receiptId, status: "review", revision, candidateIds: previous.candidateIds as string[], persisted: true, replayed: false };
      }
      const candidateRefs = candidateIds.map(candidateId => db.collection("caseMailIntakeCandidates").doc(candidateId));
      const auditRef = db.collection("auditLogs").doc(caseMailRecordKey("case-mail-received", receiptId));
      const existing = await Promise.all([...candidateRefs, auditRef].map(ref => tx.get(ref)));
      if (existing.some(snap => snap.exists)) fail("受信候補または監査記録が既に存在します。");
      const transactionIssues = [...issues];
      const checked = new Set<string>();
      for (const candidate of candidates) {
        const pair = JSON.stringify([candidate.input.workDate, candidate.input.storeName]);
        if (checked.has(pair)) continue;
        checked.add(pair);
        if (await hasCaseMailCollision(tx, config.companyId, receiptId, candidate.input.workDate, candidate.input.storeName)) {
          transactionIssues.push("SAME_DAY_STORE_REVIEW");
        }
      }
      const status = transactionIssues.length ? "review" : "ready";
      const now = Timestamp.now();
      tx.set(receiptRef, { version: 1, companyId: config.companyId, messageId, revision: 1, status,
        verification: "verified", verificationScope: "registered-server-provider",
        structuralComplete: analysis.structuralComplete, kind: "new", sourceFingerprint: analysis.sourceFingerprint,
        analysisHash, ingestedBy: config.uid, producerId: config.producerId, principalRevision: config.principalRevision,
        receivedAt: analysis.receivedAt, candidateIds, parts: analysis.parts, issues: [...new Set(transactionIssues)],
        createdAt: now, updatedAt: now });
      candidates.forEach((candidate, index) => tx.set(candidateRefs[index]!, {
        version: 1, companyId: config.companyId, receiptId, messageId, revision: 1, status,
        sourceFingerprint: analysis.sourceFingerprint, importVersion: 1, ...candidate, workDate: candidate.input.workDate,
        createdAt: now, updatedAt: now,
      }));
      tx.set(auditRef, { companyId: config.companyId, actorUid: config.uid, action: "caseMail.intake.receive",
        detail: { receiptId, revision: 1, status, candidateCount: candidates.length }, createdAt: now });
      return { receiptId, status, revision: 1, candidateIds, persisted: true, replayed: false };
    });
  };
}
