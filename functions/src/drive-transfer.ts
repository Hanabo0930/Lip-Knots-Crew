import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { getWritableDriveClient } from "./google-drive-client";

export type TransferSource = {
  bucket: string; path: string; generation: string; size: string; contentType: string; md5: string;
};
const PlanSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().positive(), name: z.string().min(1),
  parentId: z.string().min(1), sourceKey: z.string().length(64),
});
type TransferPlan = z.infer<typeof PlanSchema>;

export function transferSource(input: {
  bucket?: string; name?: string; generation?: string | number; size?: string | number;
  contentType?: string; md5Hash?: string;
}): TransferSource {
  const size = String(input.size ?? "");
  const generation = String(input.generation ?? "");
  const checksum = input.md5Hash ?? "";
  if (!input.bucket || !input.name || !/^[1-9]\d*$/.test(generation) ||
    (typeof input.generation === "number" && !Number.isSafeInteger(input.generation)) ||
    !/^[1-9]\d*$/.test(size) || !input.contentType ||
    input.contentType.startsWith("application/vnd.google-apps.") ||
    !/^[A-Za-z0-9+/]{22}==$/.test(checksum)) {
    throw new HttpsError("failed-precondition", "転送元の世代・サイズ・形式・チェックサムを確認できません。");
  }
  return { bucket: input.bucket, path: input.name, generation, size,
    contentType: input.contentType, md5: Buffer.from(checksum, "base64").toString("hex") };
}
function sourceKey(source: TransferSource): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}
export function assertTransferSource(plan: unknown, source: TransferSource): void {
  if (plan === undefined) return;
  const parsed = PlanSchema.parse(plan);
  if (parsed.sourceKey !== sourceKey(source)) {
    throw new HttpsError("failed-precondition", "保存済み転送計画と転送元が一致しません。");
  }
}
function statusCode(error: unknown): number {
  const value = error as { response?: { status?: number }; code?: number | string };
  return Number(value?.response?.status ?? value?.code);
}

export async function transferWithStableId(input: {
  fileRef: FirebaseFirestore.DocumentReference;
  counterRef: FirebaseFirestore.DocumentReference;
  source: TransferSource;
  parentId: string;
  nameForSequence: (sequence: number) => string;
  createBody: () => unknown;
}) {
  const drive = getWritableDriveClient();
  let saved: unknown = (await input.fileRef.get()).data()?.driveTransferPlan;
  if (saved === undefined) {
    const ids = await drive.files.generateIds({ count: 1, space: "drive", type: "files" });
    const id = ids.data.ids?.[0];
    if (!id) throw new Error("Driveの事前発行IDを取得できません。");
    // 外部APIはtransaction外。競合時は保存済み計画を採用し、連番を再加算しない。
    saved = await db.runTransaction(async tx => {
      const [file, counter] = await Promise.all([tx.get(input.fileRef), tx.get(input.counterRef)]);
      if (!file.exists) throw new Error("提出ファイルが見つかりません。");
      if (file.data()?.driveTransferPlan !== undefined) return file.data()!.driveTransferPlan;
      const sequence = Number(counter.data()?.value ?? 0) + 1;
      const plan: TransferPlan = { id, sequence, name: input.nameForSequence(sequence),
        parentId: input.parentId, sourceKey: sourceKey(input.source) };
      PlanSchema.parse(plan);
      tx.set(input.counterRef, { value: sequence, updatedAt: Timestamp.now() }, { merge: true });
      tx.set(input.fileRef, { driveTransferPlan: plan }, { merge: true });
      return plan;
    });
  }
  const plan = PlanSchema.parse(saved);
  assertTransferSource(plan, input.source);
  if (plan.parentId !== input.parentId) throw new Error("転送先フォルダが保存済み計画と一致しません。");
  const fields = "id,name,parents,mimeType,size,md5Checksum,appProperties,trashed,createdTime,webViewLink";
  const read = () => drive.files.get({ fileId: plan.id, fields, supportsAllDrives: true });
  let response;
  try {
    response = await read();
  } catch (error) {
    // 読取権限不足・通信障害を未作成扱いしない。
    if (statusCode(error) !== 404) throw error;
    try {
      response = await drive.files.create({
        requestBody: { id: plan.id, name: plan.name, parents: [plan.parentId],
          mimeType: input.source.contentType, appProperties: { lkcTransfer: plan.sourceKey } },
        media: { mimeType: input.source.contentType, body: input.createBody() },
        fields, supportsAllDrives: true,
      });
    } catch (createError) {
      if (statusCode(createError) !== 409) throw createError;
      response = await read();
    }
  }
  const file = response.data;
  const createdAt = Date.parse(file.createdTime ?? "");
  if (file.id !== plan.id || file.name !== plan.name || file.trashed === true ||
    file.parents?.length !== 1 || file.parents[0] !== plan.parentId ||
    file.mimeType !== input.source.contentType || String(file.size) !== input.source.size ||
    file.md5Checksum !== input.source.md5 || file.appProperties?.lkcTransfer !== plan.sourceKey ||
    !Number.isFinite(createdAt)) {
    throw new HttpsError("failed-precondition", "Drive転送結果と保存済み計画・内容が一致しません。");
  }
  return { id: plan.id, name: plan.name, sequence: plan.sequence,
    webViewLink: file.webViewLink ?? null, submittedAt: Timestamp.fromMillis(createdAt) };
}
