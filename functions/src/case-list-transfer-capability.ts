import { HttpsError } from "firebase-functions/v2/https";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import type { CaseListSource } from "./case-list-source-core";
const controller = require("../src/case-list-monthly-controller.cjs") as {
  transferCapability(snapshot: unknown, row: unknown): { supported: boolean; reason?: string };
};
export async function verifyCaseListTransferCapability(companyId: string, expected: CaseListSource, provided?: Awaited<ReturnType<typeof readCaseListMonthlySnapshot>>): Promise<void> {
  const snapshot = provided ?? await readCaseListMonthlySnapshot(companyId, expected.caseId);
  if (snapshot.spreadsheetId !== expected.spreadsheetId || snapshot.catalog?.sourceRevision !== expected.sourceRevision) throw new HttpsError("failed-precondition", "月別連携の確認中に案件リストが更新されました。もう一度確認してください。");
  const row = snapshot.source.rows.find(row => row.caseId === expected.caseId);
  const capability = row ? controller.transferCapability(snapshot, row) : { supported: false };
  if (!capability.supported) throw new HttpsError("failed-precondition", "この案件は月別連携の確認が必要です。下書きを保持しました。", { reason: "case_list_transfer_not_supported", capability: capability.reason ?? "SOURCE_MISSING" });
}
