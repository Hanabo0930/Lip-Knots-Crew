import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";
import {readAutomationJobContext,automationPreContactEvidence,makeAutomationPreContactProof,matchesAutomationPreContactProof} from "./automation-precontact-proof";

const Schema = z.object({
  jobId: z.string().min(1),
  dateKey: z.iso.date().optional(),
  temperature: z.number().min(34).max(42),
  arrivalTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
});

export const submitPreContact = onCall(async (request) => {
  const session = requireAuth(request);
  const input = Schema.parse(request.data);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const jobRef = db.collection("jobs").doc(input.jobId);

  const queueRef = db.collection("sheetSyncQueue").doc();
  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この案件へ送信できません。");
    }
    if (job.cancelled === true || job.status === "cancelled") {
      throw new HttpsError("failed-precondition", "キャンセル済みの案件です。");
    }

    if (job.status !== "assigned") throw new HttpsError("failed-precondition", "確定したシフトだけを変更できます。シフトを更新して確認してください。");
    const workDate = z.iso.date().safeParse(job.dateKey);
    if (!workDate.success || (input.dateKey !== undefined && input.dateKey !== workDate.data)) throw new HttpsError("failed-precondition", "勤務日が変更されたか確認できません。最新のシフトを確認してください。");
    // 後続の書戻しが拒否する手配状態では、入力保存や書戻し依頼を先に作らない。
    if(job.sourceMissing===true)throw new HttpsError("failed-precondition","取込元の案件を確認できません。事前連絡を保存する前に、元の案件と取込状態を確認してください。",{reason:"source_unavailable"});
    if(job.applicationUnconfirmed===true)throw new HttpsError("failed-precondition","応募内容はアプリに保存されています。シフト表で担当を確認できるまで、事前連絡は保存できません。シフトを更新して確認してください。",{reason:"assignment_sheet_confirmation_pending"});
    if(job.assignmentUnresolved===true)throw new HttpsError("failed-precondition","担当者の照合が完了していません。シフトを更新し、担当者を確認してから送信してください。",{reason:"assignment_identity_unresolved"});
    const now = Timestamp.now();
    const previous = (job.preContact ?? null) as Record<string, unknown> | null;
    const context = await readAutomationJobContext(tx,companyId,input.jobId,job);
    const sameInput = previous?.source === "app" && previous.staffId === staffId && previous.dateKey === job.dateKey &&
      previous.submittedAt instanceof Timestamp && job.preContactNeedsReview !== true &&
      Number(previous.temperature) === input.temperature && String(previous.arrivalTime ?? "").padStart(5,"0") === input.arrivalTime.padStart(5,"0");
    if(sameInput){
      const proof = makeAutomationPreContactProof(context,previous,now);
      if(!context?.binding.assignment || matchesAutomationPreContactProof(context,previous,previous?.automationProof))return;
      if(proof && automationPreContactEvidence(previous)){
        // 本人が同じ値を再送信して現在の担当版を確認。G/H書戻しは重複させない。
        tx.update(jobRef,{preContact:{...previous,automationProof:proof},updatedAt:now});
        tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,actorStaffId:staffId,
          action:"precontact.confirm-automation-proof",jobId:input.jobId,
          before:previous?.automationProof??null,after:proof,createdAt:now});
        return;
      }
    }
    const nextContact = {source:"app" as const,staffId,dateKey:workDate.data,operationId:queueRef.id,
      temperature:input.temperature,arrivalTime:input.arrivalTime,submittedAt:now,revised:previous!==null};
    tx.update(jobRef, {
      preContact: {...nextContact,automationProof:makeAutomationPreContactProof(context,nextContact,now)},
      preContactNeedsReview: false,
      preContactSyncPending: true,
      updatedAt: now,
    });

    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "precontact.submit",
      dateKey: workDate.data,
      updates: {
        temperature: input.temperature,
        arrivalTime: input.arrivalTime,
      },
      status: "pending",
      attempts: 0,
      idempotencyKey: `precontact:${input.jobId}:${queueRef.id}`,
      expected: previous ? {
        temperature: { mode: "exact", value: (previous as { temperature?: unknown }).temperature ?? "" },
        arrivalTime: { mode: "exact", value: (previous as { arrivalTime?: unknown }).arrivalTime ?? "" },
      } : {
        temperature: { mode: "blank" }, arrivalTime: { mode: "blank" },
      },
      actorUid: session.uid,
      actorStaffId: staffId,
      createdAt: now,
    });

    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      actorStaffId: staffId,
      action: previous ? "precontact.revise" : "precontact.submit",
      jobId: input.jobId,
      before: previous,
      after: {
        temperature: input.temperature,
        arrivalTime: input.arrivalTime,
      },
      createdAt: now,
    });
  });

  return { ok: true };
});
