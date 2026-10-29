import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";

// The sole CaseList public job + private approval sink, shared by the existing
// current-Source publisher and its verified Source-write continuation.
export function stageVerifiedCaseListPublication(tx: FirebaseFirestore.Transaction, jobRef: FirebaseFirestore.DocumentReference, check: { jobFields: Record<string, unknown>; candidate: Record<string, unknown>; source: { sourceRevision: string }; approval: Record<string, unknown> }, actorUid: string, now: FirebaseFirestore.Timestamp, companyId: string) {
  tx.set(jobRef, { ...check.jobFields, sourceReady: true, basePay: (check.candidate.payOffer as { dailyWageJPY: number }).dailyWageJPY, publicPayOffer: check.candidate.payOffer,
    caseListPublication: { sourceRevision: check.source.sourceRevision, confirmedAt: now }, caseListHoldReasons: [], status: "open", publishable: true, recruitmentStopped: false,
    publicationBlockedReason: FieldValue.delete(), scheduledPublishAt: FieldValue.delete(), updatedAt: now, revision: FieldValue.increment(1) }, { merge: true });
  tx.set(db.collection("caseListApprovals").doc(jobRef.id), { companyId, jobId: jobRef.id, ...check.approval, actorUid, confirmedAt: now });
}
