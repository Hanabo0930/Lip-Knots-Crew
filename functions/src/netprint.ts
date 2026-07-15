import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import { companyFromClaims, requireAdmin, requireAuth, staffFromClaims } from "./utils";
import { hashText } from "./case-id";
import { assertProductionOperational } from "./system-safety";

const UpdateSchema = z.object({
  jobId: z.string().min(1),
  numbers: z.array(z.string().max(40)).max(3),
});
const PrintSchema = z.object({ jobId: z.string().min(1), itemId: z.string().min(1) });

export const updateNetPrintNumbers = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = UpdateSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);
  let notifyStaffId = "";
  let changedCount = 0;
  let oldNumbers: string[] = [];
  let cleanNumbers: string[] = [];

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId) throw new HttpsError("permission-denied", "権限がありません。");
    const oldItems = ((job.netPrint as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []);
    oldNumbers = [0,1,2].map((index) => String(oldItems[index]?.number ?? ""));
    const clean = input.numbers.map((value) => value.trim()).filter(Boolean).slice(0, 3);
    cleanNumbers = clean;
    const now = Timestamp.now();
    const items = clean.map((number, index) => {
      const old = oldItems[index];
      const unchanged = String(old?.number ?? "") === number;
      if (!unchanged) changedCount++;
      const item: Record<string, unknown> = {
        id: unchanged && old?.id ? String(old.id) : `np_${hashText(`${input.jobId}|${index}|${number}|${now.toMillis()}`, 16)}`,
        number,
        position: index + 1,
        version: unchanged ? Number(old?.version ?? 1) : Number(old?.version ?? 0) + 1,
        printed: unchanged ? old?.printed === true : false,
        updatedAt: now,
      };
      if (unchanged && old?.printedAt) item.printedAt = old.printedAt;
      return item;
    });
    notifyStaffId = String(job.assignedStaffId ?? "");
    tx.update(jobRef, {
      netPrint: { items, updatedAt: now, changedCount },
      updatedAt: now,
    });
  });

  await db.collection("sheetSyncQueue").add({
    companyId, jobId: input.jobId, operation: "netprint.update",
    updates: { netPrint1: cleanNumbers[0] ?? "", netPrint2: cleanNumbers[1] ?? "", netPrint3: cleanNumbers[2] ?? "" },
    styles: { netPrint1: { background: "#ffffff" }, netPrint2: { background: "#ffffff" }, netPrint3: { background: "#ffffff" } },
    expected: { netPrint1: { mode:"exact", value:oldNumbers[0] ?? "" }, netPrint2: { mode:"exact", value:oldNumbers[1] ?? "" }, netPrint3: { mode:"exact", value:oldNumbers[2] ?? "" } },
    status:"pending", attempts:0, idempotencyKey:`netprint.update:${input.jobId}:${Date.now()}`, actorUid:session.uid, createdAt:FieldValue.serverTimestamp(),
  });
  if (notifyStaffId && changedCount > 0) {
    await enqueueNotification({
      companyId,
      targetStaffId: notifyStaffId,
      title: "ネットプリント番号が届きました",
      body: "できるだけ早く、遅くとも通知から1週間以内に印刷してください。",
      route: `/shifts/${input.jobId}/netprint`,
      category: "netprint_updated",
      dedupeKey: `${input.jobId}_${Date.now()}_netprint`,
    });
  }
  return { ok: true, changedCount };
});

export const markNetPrintPrinted = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = PrintSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);

  let position = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この資料を変更できません。");
    }
    const current = ((job.netPrint as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []);
    let found = false;
    const now = Timestamp.now();
    const items = current.map((item) => {
      if (String(item.id ?? "") !== input.itemId) return item;
      found = true;
      position = Number(item.position ?? 0);
      return { ...item, printed: true, printedAt: now, updatedAt: now };
    });
    if (!found) throw new HttpsError("not-found", "番号が見つかりません。");
    tx.update(jobRef, { "netPrint.items": items, updatedAt: now });
  });
  if (position >= 1 && position <= 3) {
    await db.collection("sheetSyncQueue").add({
      companyId, jobId: input.jobId, operation:"netprint.printed",
      updates:{}, styles:{ [`netPrint${position}`]: { background:"#fff2cc" } },
      status:"pending", attempts:0, idempotencyKey:`netprint.printed:${input.jobId}:${input.itemId}`, actorUid:session.uid, actorStaffId:staffId, createdAt:FieldValue.serverTimestamp(),
    });
  }
  return { ok: true };
});
