import { google, sheets_v4 } from "googleapis";
import { ShiftImportConfig, SheetDescriptor } from "./shift-import-types";

export type SheetsClient = sheets_v4.Sheets;

export async function createReadOnlySheetsClient(): Promise<SheetsClient> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function listSpreadsheetSheets(
  sheets: SheetsClient,
  spreadsheetId: string
): Promise<SheetDescriptor[]> {
  const response = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))",
    })
  );

  return (response.data.sheets ?? []).flatMap((sheet) => {
    const properties = sheet.properties;
    if (!properties?.title) return [];
    return [{
      sheetId: properties.sheetId ?? 0,
      title: properties.title,
      hidden: properties.hidden === true,
      rowCount: properties.gridProperties?.rowCount ?? 0,
      columnCount: properties.gridProperties?.columnCount ?? 0,
    }];
  });
}

export function selectImportSheets(
  descriptors: SheetDescriptor[],
  config: ShiftImportConfig,
  requestedSheets?: string[]
): SheetDescriptor[] {
  let regex: RegExp;
  try {
    regex = new RegExp(config.monthlySheetPattern);
  } catch {
    throw new Error("monthlySheetPatternが正しい正規表現ではありません。");
  }

  const requested = new Set((requestedSheets ?? []).filter(Boolean));
  const included = new Set(config.includeSheets ?? []);
  const excluded = new Set(config.excludeSheets ?? []);

  return descriptors
    .filter((sheet) => !sheet.hidden)
    .filter((sheet) => regex.test(sheet.title))
    .filter((sheet) => requested.size === 0 || requested.has(sheet.title))
    .filter((sheet) => included.size === 0 || included.has(sheet.title))
    .filter((sheet) => !excluded.has(sheet.title))
    .filter((sheet) => monthWithinRange(sheet.title, config.importFrom, config.importThrough))
    .sort((a, b) => monthNumber(a.title) - monthNumber(b.title))
    .slice(0, config.maxSheetsPerRun);
}

export async function readShiftSheet(
  sheets: SheetsClient,
  spreadsheetId: string,
  sheet: SheetDescriptor,
  endColumn: string,
  maxRows: number
): Promise<unknown[][]> {
  const endRow = Math.max(1, Math.min(sheet.rowCount || maxRows, maxRows));
  const range = `${quoteSheetName(sheet.title)}!A1:${endColumn}${endRow}`;
  const response = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      majorDimension: "ROWS",
      valueRenderOption: "FORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    })
  );
  return (response.data.values ?? []) as unknown[][];
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function monthNumber(value: string): number {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(value);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 12 + Number(match[2]);
}

function monthWithinRange(
  sheetName: string,
  from?: string | null,
  through?: string | null
): boolean {
  const current = monthNumber(sheetName);
  if (!Number.isFinite(current) || current === Number.MAX_SAFE_INTEGER) return false;
  if (from && current < monthNumber(from)) return false;
  if (through && current > monthNumber(through)) return false;
  return true;
}

async function withRetry<T>(
  task: () => Promise<T>,
  attempts = 4
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const status = getHttpStatus(error);
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || index === attempts - 1) throw error;
      await sleep(500 * (2 ** index) + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

function getHttpStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const record = error as {
    code?: number | string;
    response?: { status?: number };
  };
  if (typeof record.response?.status === "number") return record.response.status;
  if (typeof record.code === "number") return record.code;
  const parsed = Number(record.code);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function selectNamedSheets(
  descriptors: SheetDescriptor[],
  activeSheets: string[],
  excludedSheets: string[],
  requestedSheets?: string[],
  maxSheets = 20
): SheetDescriptor[] {
  const active = new Set(activeSheets);
  const excluded = new Set(excludedSheets);
  const requested = new Set((requestedSheets ?? []).filter(Boolean));

  return descriptors
    .filter((sheet) => !sheet.hidden)
    .filter((sheet) => active.has(sheet.title))
    .filter((sheet) => !excluded.has(sheet.title))
    .filter((sheet) => requested.size === 0 || requested.has(sheet.title))
    .sort((a, b) => activeSheets.indexOf(a.title) - activeSheets.indexOf(b.title))
    .slice(0, maxSheets);
}

export async function readNamedSheet(
  sheets: SheetsClient,
  spreadsheetId: string,
  sheet: SheetDescriptor,
  endColumn: string,
  maxRows: number
): Promise<unknown[][]> {
  return readShiftSheet(sheets, spreadsheetId, sheet, endColumn, maxRows);
}
