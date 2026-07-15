import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { google, sheets_v4 } from "googleapis";
import { z } from "zod";
import { db } from "./firebase";
import {
  buildSafeDraft,
  detectShiftHeader,
  detectStaffHeader,
  extractSpreadsheetId,
  monthlySheets,
} from "./setup-wizard-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";

const InspectSchema = z.object({
  shiftSpreadsheet: z.string().min(10).max(1000),
  staffSpreadsheet: z.string().min(10).max(1000).optional(),
  shiftSampleSheet: z.string().max(100).optional(),
  staffActiveSheets: z.array(z.string().min(1).max(100)).max(10)
    .default(["マスタ", "東北"]),
  staffExcludedSheets: z.array(z.string().min(1).max(100)).max(10)
    .default(["抹消"]),
  preferredIdColumn: z.string().regex(/^[A-Z]+$/).default("ZZ"),
});

const InspectionSchema = z.object({
  inspectionId: z.string().min(10),
});

export const inspectSetupWizard = onCall(
  { timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = InspectSchema.parse(request.data ?? {});

    let shiftSpreadsheetId: string;
    let staffSpreadsheetId: string;
    try {
      shiftSpreadsheetId = extractSpreadsheetId(input.shiftSpreadsheet);
      staffSpreadsheetId = extractSpreadsheetId(
        input.staffSpreadsheet || input.shiftSpreadsheet
      );
    } catch (error) {
      throw new HttpsError(
        "invalid-argument",
        error instanceof Error ? error.message : String(error)
      );
    }

    const sheets = await createReadOnlyClient();
    const [shiftMeta, staffMeta] = await Promise.all([
      inspectSpreadsheetMeta(sheets, shiftSpreadsheetId),
      shiftSpreadsheetId === staffSpreadsheetId
        ? Promise.resolve(null)
        : inspectSpreadsheetMeta(sheets, staffSpreadsheetId),
    ]);
    const effectiveStaffMeta = staffMeta ?? shiftMeta;

    const monthTabs = monthlySheets(
      shiftMeta.sheets.map((sheet) => ({
        title: sheet.title,
        hidden: sheet.hidden,
      }))
    );
    const shiftSampleSheet = input.shiftSampleSheet ||
      monthTabs.at(-1) ||
      shiftMeta.sheets.find((sheet) => !sheet.hidden)?.title;

    if (!shiftSampleSheet) {
      throw new HttpsError(
        "failed-precondition",
        "シフト表に確認できるタブがありません。"
      );
    }
    if (!shiftMeta.sheets.some((sheet) => sheet.title === shiftSampleSheet)) {
      throw new HttpsError(
        "not-found",
        `シフト確認タブ「${shiftSampleSheet}」がありません。`
      );
    }

    const staffSampleSheet =
      input.staffActiveSheets.find((name) =>
        effectiveStaffMeta.sheets.some((sheet) => sheet.title === name)
      ) ??
      effectiveStaffMeta.sheets.find((sheet) =>
        !sheet.hidden && !input.staffExcludedSheets.includes(sheet.title)
      )?.title;

    if (!staffSampleSheet) {
      throw new HttpsError(
        "failed-precondition",
        "スタッフ名簿の確認タブがありません。"
      );
    }

    const [shiftRows, staffRows] = await Promise.all([
      readPreviewRows(sheets, shiftSpreadsheetId, shiftSampleSheet, "ZZ", 30),
      readPreviewRows(sheets, staffSpreadsheetId, staffSampleSheet, "AZ", 30),
    ]);
    const shiftHeader = detectShiftHeader(shiftRows);
    const staffHeader = detectStaffHeader(staffRows);

    const formulaColumns = await detectFormulaColumns(
      sheets,
      shiftSpreadsheetId,
      shiftSampleSheet,
      shiftHeader.headerRow + 1,
      Math.min(shiftHeader.headerRow + 30, 100),
      "ZZ"
    );
    const validationColumns = await detectValidationColumns(
      sheets,
      shiftSpreadsheetId,
      shiftSampleSheet,
      shiftHeader.headerRow + 1,
      "ZZ"
    );

    const draft = buildSafeDraft({
      companyId,
      shiftSpreadsheetId,
      staffSpreadsheetId,
      shiftHeader,
      staffHeader,
      staffActiveSheets: input.staffActiveSheets,
      staffExcludedSheets: input.staffExcludedSheets,
      idColumn: input.preferredIdColumn,
    }) as {
      shiftMapping?: {
        rowCreation?: {
          formulaColumns?: string[];
          requiredValidationColumns?: string[];
        };
      };
    } & Record<string, unknown>;

    if (draft.shiftMapping?.rowCreation) {
      draft.shiftMapping.rowCreation.formulaColumns =
        formulaColumns.length ? formulaColumns : ["AA", "AJ", "AR", "BB"];
      draft.shiftMapping.rowCreation.requiredValidationColumns =
        validationColumns;
    }

    const warnings = [
      ...shiftHeader.missingRequired.map(
        (key) => `シフト表の必須列「${key}」を自動検出できませんでした。`
      ),
      ...staffHeader.missingRequired.map(
        (key) => `スタッフ名簿の必須列「${key}」を自動検出できませんでした。`
      ),
    ];
    if (!monthTabs.length) warnings.push("YYYY.M形式の月別タブが見つかりません。");
    if (!formulaColumns.length) warnings.push("数式列を自動検出できませんでした。");
    if (!validationColumns.length) {
      warnings.push("見本行に入力規則が見つかりませんでした。");
    }

    const inspectionRef = db.collection("setupWizardInspections").doc();
    const expiresAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
    await inspectionRef.set({
      companyId,
      actorUid: session.uid,
      status: "inspected",
      shiftSpreadsheetId,
      staffSpreadsheetId,
      shiftSampleSheet,
      staffSampleSheet,
      shiftMeta,
      staffMeta: effectiveStaffMeta,
      shiftHeader,
      staffHeader,
      formulaColumns,
      validationColumns,
      monthTabs,
      draft,
      warnings,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
    });

    await db.collection("auditLogs").add({
      companyId,
      actorUid: session.uid,
      action: "setup.wizard.inspect",
      inspectionId: inspectionRef.id,
      shiftSpreadsheetId,
      staffSpreadsheetId,
      requestId: requestId("audit"),
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      inspectionId: inspectionRef.id,
      expiresAt: expiresAt.toDate().toISOString(),
      shiftSpreadsheet: {
        id: shiftSpreadsheetId,
        title: shiftMeta.title,
        sampleSheet: shiftSampleSheet,
        monthTabs,
        header: shiftHeader,
        formulaColumns,
        validationColumns,
      },
      staffSpreadsheet: {
        id: staffSpreadsheetId,
        title: effectiveStaffMeta.title,
        sampleSheet: staffSampleSheet,
        header: staffHeader,
        activeSheetsFound: input.staffActiveSheets.filter((name) =>
          effectiveStaffMeta.sheets.some((sheet) => sheet.title === name)
        ),
        excludedSheetsFound: input.staffExcludedSheets.filter((name) =>
          effectiveStaffMeta.sheets.some((sheet) => sheet.title === name)
        ),
      },
      warnings,
      draft,
    };
  }
);

export const saveSetupWizardDraft = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = InspectionSchema.parse(request.data ?? {});
  const inspection = await db.collection("setupWizardInspections")
    .doc(input.inspectionId)
    .get();

  const expiresAt = inspection.data()?.expiresAt as Timestamp | undefined;
  if (
    !inspection.exists ||
    inspection.data()?.companyId !== companyId ||
    !expiresAt ||
    expiresAt.toMillis() <= Date.now()
  ) {
    throw new HttpsError(
      "failed-precondition",
      "検査結果が見つからないか、有効期限が切れています。"
    );
  }

  const draft = inspection.data()?.draft;
  const draftRef = db.collection("setupWizardDrafts").doc(companyId);
  await draftRef.set({
    companyId,
    inspectionId: inspection.id,
    draft,
    warnings: inspection.data()?.warnings ?? [],
    allEnabled: false,
    status: "draft_only",
    savedBy: session.uid,
    savedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await inspection.ref.set({
    status: "draft_saved",
    savedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    saved: true,
    path: `setupWizardDrafts/${companyId}`,
    allEnabled: false,
  };
});

export const getSetupWizardDraft = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const draft = await db.collection("setupWizardDrafts").doc(companyId).get();
  return {
    exists: draft.exists,
    ...(draft.exists ? serialize(draft.data() ?? {}) : {}),
  };
});

async function createReadOnlyClient(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function inspectSpreadsheetMeta(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<{
  title: string;
  spreadsheetId: string;
  sheets: Array<{
    title: string;
    sheetId: number;
    hidden: boolean;
    rowCount: number;
    columnCount: number;
  }>;
}> {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties(title),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))",
    });
    return {
      title: response.data.properties?.title ?? "",
      spreadsheetId,
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
        }];
      }),
    };
  } catch (error) {
    throw new HttpsError(
      "failed-precondition",
      `スプレッドシートを読めません。閲覧共有とIDを確認してください。${
        error instanceof Error ? ` ${error.message}` : ""
      }`
    );
  }
}

async function readPreviewRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  endColumn: string,
  rows: number
): Promise<unknown[][]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${quote(sheetName)}'!A1:${endColumn}${rows}`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (response.data.values ?? []) as unknown[][];
}

async function detectFormulaColumns(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  startRow: number,
  endRow: number,
  endColumn: string
): Promise<string[]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${quote(sheetName)}'!A${startRow}:${endColumn}${endRow}`,
    valueRenderOption: "FORMULA",
  });
  const found = new Set<string>();
  for (const row of response.data.values ?? []) {
    row.forEach((value, index) => {
      if (String(value ?? "").trim().startsWith("=")) {
        found.add(columnLetter(index));
      }
    });
  }
  return [...found].sort((a, b) => columnNumber(a) - columnNumber(b));
}

async function detectValidationColumns(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  endColumn: string
): Promise<string[]> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${quote(sheetName)}'!A${rowNumber}:${endColumn}${rowNumber}`],
    includeGridData: true,
    fields: "sheets(data(startColumn,rowData(values(dataValidation))))",
  });
  const found = new Set<string>();
  for (const data of response.data.sheets?.[0]?.data ?? []) {
    const startColumn = data.startColumn ?? 0;
    const values = data.rowData?.[0]?.values ?? [];
    values.forEach((cell, offset) => {
      if (cell.dataValidation) found.add(columnLetter(startColumn + offset));
    });
  }
  return [...found].sort((a, b) => columnNumber(a) - columnNumber(b));
}

function quote(value: string): string {
  return value.replace(/'/g, "''");
}

function columnLetter(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function columnNumber(value: string): number {
  return [...value].reduce(
    (total, character) => total * 26 + character.charCodeAt(0) - 64,
    0
  );
}

function serialize(
  data: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    value instanceof Timestamp ? value.toDate().toISOString() : value,
  ]));
}
