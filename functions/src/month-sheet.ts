import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { google, sheets_v4 } from "googleapis";
import { z } from "zod";
import { db } from "./firebase";
import {
  buildMonthCreationPlan,
  compareFormulaSamples,
  compareMonthMetadata,
  formulaSampleRows,
  normalizeMonth,
  SheetMetaCore,
} from "./month-sheet-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";
import { assertProductionOperational } from "./system-safety";

type ShiftMapping = {
  enabled?: boolean;
  spreadsheetId: string;
  idColumn: string;
  columns: Record<string, string>;
  rowCreation?: {
    dataStartRow?: number;
    maxRows?: number;
    formulaColumns?: string[];
    requiredValidationColumns?: string[];
  };
  monthCreation?: {
    enabled?: boolean;
    verifiedSpreadsheetId?: string;
    rollbackOnVerificationFailure?: boolean;
    maxRows?: number;
  };
};

const MonthSchema = z.object({
  targetMonth: z.string().min(6).max(20),
  sourceMonth: z.string().min(6).max(20).optional(),
});

const CreateSchema = MonthSchema.extend({
  confirmation: z.literal("検証コピーで作成"),
});

export const previewMonthSheetCreation = onCall(
  { timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = MonthSchema.parse(request.data ?? {});
    const mapping = await loadMapping(companyId);
    return buildPreview(mapping, input.targetMonth, input.sourceMonth);
  }
);

export const createMonthSheetSafe = onCall(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    await assertProductionOperational(companyId);
    const input = CreateSchema.parse(request.data ?? {});
    const mapping = await loadMapping(companyId);
    await ensureMonthCreationEnabled(companyId, mapping);

    const targetMonth = normalizeMonth(input.targetMonth);
    const lock = await acquireLock(companyId, targetMonth);
    const runRef = db.collection("monthSheetCreationRuns").doc();
    let createdSheetId: number | null = null;

    try {
      await runRef.set({
        companyId,
        actorUid: session.uid,
        targetMonth,
        sourceMonth: input.sourceMonth ?? null,
        spreadsheetId: mapping.spreadsheetId,
        status: "processing",
        startedAt: FieldValue.serverTimestamp(),
      });

      const preview = await buildPreview(
        mapping,
        targetMonth,
        input.sourceMonth
      );
      if (!preview.ready) {
        throw new SafeStopError(preview.errors.join(" / "));
      }

      const sheets = await createWriteClient();
      const duplicate = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: mapping.spreadsheetId,
        requestBody: {
          requests: [{
            duplicateSheet: {
              sourceSheetId: preview.plan.sourceSheetId,
              newSheetName: preview.plan.targetMonth,
            },
          }],
        },
      });
      createdSheetId =
        duplicate.data.replies?.[0]?.duplicateSheet?.properties?.sheetId ??
        null;
      if (createdSheetId === null) {
        const refreshed = await readMonthMetadata(sheets, mapping.spreadsheetId);
        createdSheetId = refreshed.sheets.find(
          (sheet) => sheet.title === preview.plan.targetMonth
        )?.sheetId ?? null;
      }
      if (createdSheetId === null) {
        throw new Error("新しい月タブのsheetIdを取得できません。");
      }

      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: mapping.spreadsheetId,
        requestBody: { ranges: preview.plan.clearRanges },
      });

      const verification = await verifyNewMonth(
        sheets,
        mapping,
        preview,
        createdSheetId
      );

      if (!verification.ok) {
        const rollback =
          mapping.monthCreation?.rollbackOnVerificationFailure !== false;
        if (rollback) {
          await deleteSheet(sheets, mapping.spreadsheetId, createdSheetId);
          createdSheetId = null;
        }
        throw new SafeStopError(
          `新しい月タブの検算に失敗${
            rollback ? "したため削除しました" : "しました"
          }: ${verification.errors.join(" / ")}`
        );
      }

      await runRef.set({
        status: "completed",
        sourceMonth: preview.plan.sourceMonth,
        targetMonth: preview.plan.targetMonth,
        createdSheetId,
        clearRanges: preview.plan.clearRanges,
        verification,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await db.collection("auditLogs").add({
        companyId,
        actorUid: session.uid,
        action: "sheet.month.create",
        runId: runRef.id,
        spreadsheetId: mapping.spreadsheetId,
        sourceMonth: preview.plan.sourceMonth,
        targetMonth: preview.plan.targetMonth,
        createdSheetId,
        verification,
        requestId: requestId("audit"),
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        created: true,
        runId: runRef.id,
        sourceMonth: preview.plan.sourceMonth,
        targetMonth: preview.plan.targetMonth,
        createdSheetId,
        verification,
      };
    } catch (error) {
      if (createdSheetId !== null) {
        try {
          const sheets = await createWriteClient();
          await deleteSheet(sheets, mapping.spreadsheetId, createdSheetId);
          createdSheetId = null;
        } catch (rollbackError) {
          await db.collection("monthSheetManualInterventions").add({
            companyId,
            runId: runRef.id,
            spreadsheetId: mapping.spreadsheetId,
            targetMonth,
            createdSheetId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            rollbackError:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            status: "open",
            createdAt: FieldValue.serverTimestamp(),
          });
        }
      }

      await runRef.set({
        status: error instanceof SafeStopError ? "blocked" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      if (error instanceof HttpsError) throw error;
      throw new HttpsError(
        error instanceof SafeStopError
          ? "failed-precondition"
          : "internal",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await releaseLock(lock);
    }
  }
);

export const getMonthCreationHistory = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const runs = await db.collection("monthSheetCreationRuns")
    .where("companyId", "==", companyId)
    .orderBy("startedAt", "desc")
    .limit(20)
    .get();
  return {
    runs: runs.docs.map((doc) => ({
      id: doc.id,
      ...serialize(doc.data()),
    })),
  };
});

async function buildPreview(
  mapping: ShiftMapping,
  targetMonthRaw: string,
  sourceMonthRaw?: string
): Promise<{
  ready: boolean;
  errors: string[];
  warnings: string[];
  plan: ReturnType<typeof buildMonthCreationPlan>;
  sourceMeta: MonthMeta;
  formulaSamples: string[];
  validationColumns: string[];
  activation: {
    mappingEnabled: boolean;
    monthCreationEnabled: boolean;
    verifiedCopy: boolean;
  };
}> {
  if (!mapping.spreadsheetId) {
    throw new HttpsError(
      "failed-precondition",
      "スプレッドシートIDが設定されていません。"
    );
  }
  const targetMonth = normalizeMonth(targetMonthRaw);
  const sourceMonth = sourceMonthRaw
    ? normalizeMonth(sourceMonthRaw)
    : undefined;
  const sheets = await createReadOnlyClient();
  const metadata = await readMonthMetadata(sheets, mapping.spreadsheetId);
  const dataStartRow = mapping.rowCreation?.dataStartRow ?? 2;
  const configuredMaxRows =
    mapping.monthCreation?.maxRows ??
    mapping.rowCreation?.maxRows ??
    10000;
  const formulaColumns =
    mapping.rowCreation?.formulaColumns ?? ["AA", "AJ", "AR", "BB"];
  const mutableColumns = Object.values(mapping.columns ?? {});
  const plan = buildMonthCreationPlan({
    targetMonth,
    sourceMonth,
    sheets: metadata.sheets,
    mutableColumns,
    formulaColumns,
    dataStartRow,
    maxRows: Math.min(
      configuredMaxRows,
      metadata.sheets.find((sheet) =>
        sheet.title === (sourceMonth ?? planlessSource(
          targetMonth,
          metadata.sheets.map((sheet) => sheet.title)
        ))
      )?.rowCount ?? configuredMaxRows
    ),
  });
  const sourceMeta = metadata.sheets.find(
    (sheet) => sheet.title === plan.sourceMonth
  );
  if (!sourceMeta) throw new Error("複製元メタデータがありません。");

  const sampleRows = formulaSampleRows(
    dataStartRow,
    Math.min(
      sourceMeta.rowCount,
      mapping.monthCreation?.maxRows ??
      mapping.rowCreation?.maxRows ??
      sourceMeta.rowCount
    ),
    5
  );
  const formulaSamples = sampleRows.flatMap((row) =>
    formulaColumns.map((column) => `${column}${row}`)
  );
  const validationColumns =
    mapping.rowCreation?.requiredValidationColumns ?? [];

  const activation = {
    mappingEnabled: mapping.enabled === true,
    monthCreationEnabled: mapping.monthCreation?.enabled === true,
    verifiedCopy:
      mapping.monthCreation?.verifiedSpreadsheetId ===
      mapping.spreadsheetId,
  };
  const warnings = [...plan.warnings];
  if (!activation.mappingEnabled) warnings.push("安全書込は現在OFFです。");
  if (!activation.monthCreationEnabled) warnings.push("新月タブ作成は現在OFFです。");
  if (!activation.verifiedCopy) {
    warnings.push("このスプレッドシートは検証コピーとして承認されていません。");
  }

  return {
    ready: true,
    errors: [],
    warnings,
    plan,
    sourceMeta,
    formulaSamples,
    validationColumns,
    activation,
  };
}

async function verifyNewMonth(
  sheets: sheets_v4.Sheets,
  mapping: ShiftMapping,
  preview: Awaited<ReturnType<typeof buildPreview>>,
  targetSheetId: number
): Promise<{
  ok: boolean;
  errors: string[];
  metadataErrors: string[];
  formulaErrors: string[];
  validationErrors: string[];
  unclearedCells: string[];
}> {
  const metadata = await readMonthMetadata(sheets, mapping.spreadsheetId);
  const targetMeta = metadata.sheets.find(
    (sheet) => sheet.sheetId === targetSheetId &&
      sheet.title === preview.plan.targetMonth
  );
  if (!targetMeta) {
    return {
      ok: false,
      errors: ["作成した月タブを再取得できません。"],
      metadataErrors: ["作成した月タブを再取得できません。"],
      formulaErrors: [],
      validationErrors: [],
      unclearedCells: [],
    };
  }

  const metadataErrors = compareMonthMetadata(
    {
      conditionalFormatCount: preview.sourceMeta.conditionalFormatCount,
      protectedRangeCount: preview.sourceMeta.protectedRangeCount,
      rowCount: preview.sourceMeta.rowCount,
      columnCount: preview.sourceMeta.columnCount,
    },
    {
      conditionalFormatCount: targetMeta.conditionalFormatCount,
      protectedRangeCount: targetMeta.protectedRangeCount,
      rowCount: targetMeta.rowCount,
      columnCount: targetMeta.columnCount,
    }
  );

  const sourceFormulas = await readFormulaMap(
    sheets,
    mapping.spreadsheetId,
    preview.plan.sourceMonth,
    preview.formulaSamples
  );
  const targetFormulas = await readFormulaMap(
    sheets,
    mapping.spreadsheetId,
    preview.plan.targetMonth,
    preview.formulaSamples
  );
  const normalizedSource = normalizeFormulaMap(
    sourceFormulas,
    preview.plan.sourceMonth,
    preview.plan.targetMonth
  );
  const normalizedTarget = normalizeFormulaMap(
    targetFormulas,
    preview.plan.sourceMonth,
    preview.plan.targetMonth
  );
  const formulaErrors = compareFormulaSamples(
    normalizedSource,
    normalizedTarget
  );

  const validationErrors = await compareValidations(
    sheets,
    mapping.spreadsheetId,
    preview.plan.sourceMonth,
    preview.plan.targetMonth,
    preview.validationColumns,
    mapping.rowCreation?.dataStartRow ?? 2
  );

  const unclearedCells = await findUnclearedCells(
    sheets,
    mapping.spreadsheetId,
    preview.plan.clearRanges,
    30
  );
  const clearErrors = unclearedCells.length
    ? [`初期化対象に値が${unclearedCells.length}件残っています。`]
    : [];

  const errors = [
    ...metadataErrors,
    ...formulaErrors,
    ...validationErrors,
    ...clearErrors,
  ];
  return {
    ok: errors.length === 0,
    errors,
    metadataErrors,
    formulaErrors,
    validationErrors,
    unclearedCells,
  };
}

type MonthMeta = SheetMetaCore & {
  rowCount: number;
  columnCount: number;
  conditionalFormatCount: number;
  protectedRangeCount: number;
};

async function readMonthMetadata(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<{ sheets: MonthMeta[] }> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),conditionalFormats,protectedRanges)",
  });
  return {
    sheets: (response.data.sheets ?? []).flatMap((sheet) => {
      const properties = sheet.properties;
      if (
        !properties?.title ||
        properties.sheetId === null ||
        properties.sheetId === undefined
      ) return [];
      return [{
        title: properties.title,
        sheetId: properties.sheetId,
        hidden: properties.hidden === true,
        rowCount: properties.gridProperties?.rowCount ?? 0,
        columnCount: properties.gridProperties?.columnCount ?? 0,
        conditionalFormatCount: sheet.conditionalFormats?.length ?? 0,
        protectedRangeCount: sheet.protectedRanges?.length ?? 0,
      }];
    }),
  };
}

async function readFormulaMap(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  cells: string[]
): Promise<Record<string, string>> {
  if (!cells.length) return {};
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: cells.map((cell) => `'${quote(sheetName)}'!${cell}`),
    valueRenderOption: "FORMULA",
  });
  return Object.fromEntries(cells.map((cell, index) => [
    cell,
    String(response.data.valueRanges?.[index]?.values?.[0]?.[0] ?? ""),
  ]));
}

function normalizeFormulaMap(
  values: Record<string, string>,
  sourceMonth: string,
  targetMonth: string
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([cell, formula]) => [
    cell,
    formula
      .replaceAll(`'${sourceMonth}'`, "'<MONTH>'")
      .replaceAll(`'${targetMonth}'`, "'<MONTH>'")
      .replaceAll(sourceMonth, "<MONTH>")
      .replaceAll(targetMonth, "<MONTH>"),
  ]));
}

async function compareValidations(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sourceMonth: string,
  targetMonth: string,
  columns: string[],
  rowNumber: number
): Promise<string[]> {
  if (!columns.length) return [];
  const [source, target] = await Promise.all([
    validationMap(sheets, spreadsheetId, sourceMonth, columns, rowNumber),
    validationMap(sheets, spreadsheetId, targetMonth, columns, rowNumber),
  ]);
  return columns
    .filter((column) => source[column] !== target[column])
    .map((column) => `${column}列の入力規則が複製元と一致しません。`);
}

async function validationMap(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  columns: string[],
  rowNumber: number
): Promise<Record<string, boolean>> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: columns.map((column) =>
      `'${quote(sheetName)}'!${column}${rowNumber}`
    ),
    includeGridData: true,
    fields: "sheets(data(startColumn,rowData(values(dataValidation))))",
  });
  const map = Object.fromEntries(columns.map((column) => [column, false]));
  for (const data of response.data.sheets?.[0]?.data ?? []) {
    const startColumn = data.startColumn ?? 0;
    const values = data.rowData?.[0]?.values ?? [];
    values.forEach((cell, offset) => {
      const column = indexToColumn(startColumn + offset);
      if (column in map) map[column] = Boolean(cell.dataValidation);
    });
  }
  return map;
}

async function findUnclearedCells(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  ranges: string[],
  limit: number
): Promise<string[]> {
  if (!ranges.length) return [];
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const found: string[] = [];
  response.data.valueRanges?.forEach((range) => {
    (range.values ?? []).forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (String(value ?? "").trim() && found.length < limit) {
          found.push(`${range.range ?? "range"}:${rowIndex + 1}:${columnIndex + 1}`);
        }
      });
    });
  });
  return found;
}

async function loadMapping(companyId: string): Promise<ShiftMapping> {
  const snap = await db.doc(`companies/${companyId}/sheetMappings/shift`).get();
  if (!snap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "安全書込マッピングがありません。"
    );
  }
  return snap.data() as ShiftMapping;
}

async function ensureMonthCreationEnabled(
  companyId: string,
  mapping: ShiftMapping
): Promise<void> {
  const feature = await db.collection("companyFeatureSettings")
    .doc(companyId)
    .get();
  if (mapping.enabled !== true) {
    throw new SafeStopError("安全書込がOFFです。");
  }
  if (mapping.monthCreation?.enabled !== true) {
    throw new SafeStopError("新月タブ作成がOFFです。");
  }
  if (
    mapping.monthCreation?.verifiedSpreadsheetId !==
    mapping.spreadsheetId
  ) {
    throw new SafeStopError(
      "対象スプシが検証コピーとして承認されていません。"
    );
  }
  if (feature.data()?.monthSheetCreationReady !== true) {
    throw new SafeStopError("新月タブ作成の会社設定がOFFです。");
  }
}

async function createReadOnlyClient(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function createWriteClient(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function deleteSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number
): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ deleteSheet: { sheetId } }],
    },
  });
}

async function acquireLock(
  companyId: string,
  targetMonth: string
): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}> {
  const ref = db.collection("syncLocks").doc(
    `${companyId}_month_create_${targetMonth.replace(".", "_")}`
  );
  const token = db.collection("_ids").doc().id;
  const now = Timestamp.now();
  const leaseUntil = Timestamp.fromMillis(now.toMillis() + 10 * 60 * 1000);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data()?.leaseUntil as Timestamp | undefined;
    if (current && current.toMillis() > now.toMillis()) {
      throw new HttpsError(
        "already-exists",
        `「${targetMonth}」の作成処理が実行中です。`
      );
    }
    tx.set(ref, {
      companyId,
      token,
      targetMonth,
      acquiredAt: now,
      leaseUntil,
    });
  });
  return { ref, token };
}

async function releaseLock(lock: {
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lock.ref);
    if (snap.data()?.token === lock.token) tx.delete(lock.ref);
  });
}

function planlessSource(target: string, sheetNames: string[]): string {
  const targetNumber = monthNumber(target);
  return sheetNames
    .filter((name) => /^\d{4}\.\d{1,2}$/.test(name))
    .filter((name) => monthNumber(name) < targetNumber)
    .sort((a, b) => monthNumber(b) - monthNumber(a))[0] ?? "";
}

function monthNumber(value: string): number {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(value);
  return match
    ? Number(match[1]) * 12 + Number(match[2])
    : Number.MAX_SAFE_INTEGER;
}

function quote(value: string): string {
  return value.replace(/'/g, "''");
}

function indexToColumn(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function serialize(
  data: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    value instanceof Timestamp ? value.toDate().toISOString() : value,
  ]));
}

class SafeStopError extends Error {}
