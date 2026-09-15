import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { notificationQueueId, queueDocumentData } from "./notification-core";
import { companyFromClaims, requireAdmin, requireAuth, staffFromClaims } from "./utils";
import { hashText } from "./case-id";
import { cancellationSheetWriteIdentity as netPrintWriteIdentity } from "./sheet-write-core";
import { assertProductionOperational } from "./system-safety";

const UpdateSchema = z.object({
  jobId: z.string().min(1),
  numbers: z.array(z.string().max(40)).max(3),
});
const PrintSchema = z.object({ jobId: z.string().min(1), itemId: z.string().min(1), dateKey: z.iso.date().optional() });

export const updateNetPrintNumbers = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = UpdateSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);
  const queueRef = db.collection("sheetSyncQueue").doc();
  let changedCount = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId) throw new HttpsError("permission-denied", "権限がありません。");
    const oldItems = ((job.netPrint as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []);
    const oldNumbers = [0,1,2].map((index) => String(oldItems[index]?.number ?? ""));
    const clean = input.numbers.map((value) => value.trim()).filter(Boolean).slice(0, 3);
    const cleanNumbers = clean;
    changedCount = oldItems.slice(clean.length).filter(item => String(item?.number ?? "").trim()).length;
    const now = Timestamp.now();
    const identity = netPrintWriteIdentity(job);
    const items = clean.map((number, index) => {
      const old = oldItems[index];
      const unchanged = String(old?.number ?? "") === number;
      if (!unchanged) changedCount++;
      const sameItem = unchanged && typeof old?.id === "string" && !!old.id && old.position === index + 1 &&
        oldItems.filter(item => item?.id === old.id).length === 1;
      const priorVersion = Number.isSafeInteger(old?.version) && Number(old?.version) > 0 ? Number(old?.version) : 0;
      const version = sameItem ? Math.max(1, priorVersion) : priorVersion + 1;
      if (!Number.isSafeInteger(version)) throw new HttpsError("failed-precondition", "資料の版番号を更新できません。現在の資料を確認してください。");
      const item: Record<string, unknown> = {
        id: sameItem ? String(old!.id) : `np_${hashText(`${input.jobId}|${index}|${number}|${queueRef.id}`, 16)}`,
        number,
        position: index + 1,
        version,
        printed: sameItem && old?.printed === true && old.printedAt instanceof Timestamp && old.printedContext === identity &&
          old.printedByStaffId === job.assignedStaffId && old.printedForDate === job.dateKey && typeof old.printOperationId === "string",
        updatedAt: now,
      };
      if (item.printed === true && old) {
        for (const key of ["printedAt", "printedContext", "printedByStaffId", "printedForDate", "printOperationId"]) {
          if (old[key] !== undefined) item[key] = old[key];
        }
      }
      return item;
    });
    const updates = { netPrint1: cleanNumbers[0] ?? "", netPrint2: cleanNumbers[1] ?? "", netPrint3: cleanNumbers[2] ?? "" };
    const styles = Object.fromEntries([1,2,3].map(position => [`netPrint${position}`, { background: items[position-1]?.printed === true ? "#fff2cc" : "#ffffff" }]));
    const previous = job.netPrint as Record<string, unknown> | undefined;
    let expected = { netPrint1: { mode:"exact", value:oldNumbers[0] ?? "" }, netPrint2: { mode:"exact", value:oldNumbers[1] ?? "" }, netPrint3: { mode:"exact", value:oldNumbers[2] ?? "" } };
    if (previous?.syncPending === true) {
      if (previous.writeIdentity !== identity) throw new HttpsError("failed-precondition", "未反映の資料があります。担当・勤務日・元シフト表の変更を照合してから登録してください。");
      const baseline = previous.writeExpected as Record<string, { mode?: unknown; value?: unknown }> | undefined;
      if (!baseline || Object.keys(baseline).sort().join(",") !== "netPrint1,netPrint2,netPrint3" ||
          Object.values(baseline).some(value => !value || value.mode !== "exact" || typeof value.value !== "string")) {
        throw new HttpsError("failed-precondition", "前の資料番号の反映を確認できません。シフト表との照合が必要です。");
      }
      // 未反映のアプリ内番号を、原本で確認済みの値として扱わない。
      expected = baseline as typeof expected;
    }
    const notifyStaffId = String(job.assignedStaffId ?? "");
    tx.update(jobRef, {
      netPrint: { items, updatedAt: now, changedCount, writeOperationId: queueRef.id, writeIdentity: identity, syncPending: true, writeStyles: styles, writeExpected: expected },
      updatedAt: now,
    });
    tx.create(queueRef, {
      companyId, jobId: input.jobId, operation: "netprint.update",
      updates,
      styles,
      expected,
      status:"pending", attempts:0, idempotencyKey:`netprint.update:${input.jobId}:${queueRef.id}`, actorUid:session.uid, createdAt:FieldValue.serverTimestamp(),
    });
    if (notifyStaffId && changedCount > 0 && job.cancelled !== true && job.status !== "cancelled") {
      const notification = {
        companyId,
        targetStaffId: notifyStaffId,
        title: cleanNumbers.length ? "ネットプリント番号が届きました" : "ネットプリント番号が取り消されました",
        body: cleanNumbers.length ? "できるだけ早く、遅くとも通知から1週間以内に印刷してください。" : "シフトの資料情報を確認してください。",
        route: `/shifts/${input.jobId}/netprint`,
        category: "netprint_updated",
        dedupeKey: `${input.jobId}_${queueRef.id}_netprint`,
      };
      tx.create(db.collection("notificationQueue").doc(notificationQueueId(notification)), { ...queueDocumentData(notification), createdAt: now, updatedAt: now });
    }
  });
  return { ok: true, changedCount };
});

export const markNetPrintPrinted = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = PrintSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);

  const queueRef = db.collection("sheetSyncQueue").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) throw new HttpsError("permission-denied", "この資料を変更できません。");
    if (job.cancelled === true || job.status === "cancelled") throw new HttpsError("failed-precondition", "キャンセル済みの案件です。");
    if (job.status !== "assigned") throw new HttpsError("failed-precondition", "確定したシフトだけを変更できます。シフトを更新して確認してください。");
    if (job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true) throw new HttpsError("failed-precondition", "現在の担当・元シフト表を確認してから印刷済みにしてください。");
    const day = z.iso.date().safeParse(job.dateKey);
    if (!day.success || (input.dateKey !== undefined && input.dateKey !== day.data)) throw new HttpsError("failed-precondition", "勤務日が変更されたか確認できません。最新のシフトを確認してください。");
    const identity = netPrintWriteIdentity(job);
    const current = ((job.netPrint as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []);
    const targets = current.filter(item => item && String(item.id ?? "") === input.itemId);
    if (targets.length > 1) throw new HttpsError("failed-precondition", "印刷対象を一意に確認できません。番号を再登録して確認してください。");
    const target = targets[0];
    if (!target) throw new HttpsError("not-found", "番号が見つかりません。");
    const position = Number(target.position ?? 0);
    const number = String(target.number ?? "").trim();
    if (!Number.isInteger(position) || position < 1 || position > 3 || !number) throw new HttpsError("failed-precondition", "印刷対象の番号を確認できません。");
    if (target.printed === true && (!target.printOperationId || (target.printedContext === identity && target.printedByStaffId === staffId && target.printedForDate === day.data))) return;
    const now = Timestamp.now();
    const items = current.map(item => item === target ? { ...item, printed: true, printedAt: now, updatedAt: now, printOperationId: queueRef.id, printedContext: identity, printedByStaffId: staffId, printedForDate: day.data } : item);
    tx.update(jobRef, {
      "netPrint.items": items, updatedAt: now,
      ...((job.netPrint as { needsPrintReview?: unknown } | undefined)?.needsPrintReview === true
        ? { "netPrint.needsPrintReview": items.some(item => !item || item.printed !== true) } : {}),
    });
    tx.create(queueRef, {
      companyId, jobId: input.jobId, operation:"netprint.printed", dateKey: day.data,
      updates:{}, styles:{ [`netPrint${position}`]: { background:"#fff2cc" } },
      expected:{ [`netPrint${position}`]: { mode:"exact", value:number } },
      status:"pending", attempts:0, idempotencyKey:`netprint.printed:${input.jobId}:${queueRef.id}`, actorUid:session.uid, actorStaffId:staffId, createdAt:now,
    });
  });
  return { ok: true };
});
