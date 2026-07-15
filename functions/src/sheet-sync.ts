import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { google } from "googleapis";
import { db } from "./firebase";

type SyncQueue = {
  companyId: string;
  jobId: string;
  updates: Record<string, string | number | boolean | null>;
  attempts?: number;
};

type Mapping = {
  spreadsheetId: string;
  idColumn: string;
  columns: Record<string, string>;
};

export const processSheetSync = onDocumentCreated(
  "sheetSyncQueue/{queueId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const queue = snap.data() as SyncQueue;
    const queueRef = snap.ref;
    await queueRef.set({
      status: "processing",
      startedAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    }, { merge: true });

    try {
      const [jobSnap, mappingSnap] = await Promise.all([
        db.collection("jobs").doc(queue.jobId).get(),
        db.doc(`companies/${queue.companyId}/sheetMappings/shift`).get(),
      ]);
      if (!jobSnap.exists || !mappingSnap.exists) {
        throw new Error("案件または列マッピングが見つかりません。");
      }

      const job = jobSnap.data() as {
        caseId?: string;
        sheetRef?: { sheetName?: string; currentRow?: number };
      };
      const mapping = mappingSnap.data() as Mapping;
      const sheetName = job.sheetRef?.sheetName;
      if (!sheetName) throw new Error("対象月タブが不明です。");

      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const sheets = google.sheets({ version: "v4", auth });

      const row = await locateRow(
        sheets,
        mapping.spreadsheetId,
        sheetName,
        mapping.idColumn,
        job.caseId,
        job.sheetRef?.currentRow
      );

      const data = Object.entries(queue.updates).flatMap(([key, value]) => {
        const column = mapping.columns[key];
        if (!column) return [];
        return [{
          range: `'${sheetName}'!${column}${row}`,
          values: [[value ?? ""]],
        }];
      });

      if (!data.length) {
        throw new Error("更新可能な列がありません。");
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: mapping.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data,
        },
      });

      await queueRef.set({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        resolvedRow: row,
      }, { merge: true });
    } catch (error) {
      await queueRef.set({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw error;
    }
  }
);

async function locateRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetName: string,
  idColumn: string,
  caseId?: string,
  fallbackRow?: number
): Promise<number> {
  if (caseId) {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!${idColumn}:${idColumn}`,
    });
    const values = result.data.values ?? [];
    const index = values.findIndex((row) => row[0] === caseId);
    if (index >= 0) return index + 1;
  }
  if (fallbackRow && fallbackRow > 0) return fallbackRow;
  throw new Error("案件IDに一致する行を特定できません。");
}
