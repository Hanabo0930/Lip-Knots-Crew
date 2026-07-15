export type ExpenseValues = {
  transportation: number | null;
  purchase8: number | null;
  purchase10: number | null;
  netPrintCost: number | null;
  postageCost: number | null;
};

export type ExpenseInput = Partial<Record<keyof ExpenseValues, unknown>>;

const EXPENSE_KEYS: Array<keyof ExpenseValues> = [
  "transportation",
  "purchase8",
  "purchase10",
  "netPrintCost",
  "postageCost",
];

export function normalizeExpenseInput(input: ExpenseInput): {
  values: ExpenseValues;
  errors: string[];
} {
  const values = {} as ExpenseValues;
  const errors: string[] = [];

  for (const key of EXPENSE_KEYS) {
    const parsed = parseExpenseValue(input[key]);
    values[key] = parsed.value;
    if (parsed.error) errors.push(`${labelFor(key)}: ${parsed.error}`);
  }

  return { values, errors };
}

export function buildExpenseSheetUpdates(values: ExpenseValues): Record<string, number | ""> {
  return {
    transportation: values.transportation ?? "",
    purchase8: values.purchase8 ?? "",
    purchase10: values.purchase10 ?? "",
    netPrintCost: values.netPrintCost ?? "",
    postageCost: values.postageCost ?? "",
  };
}

export function buildExpenseExpected(
  values: ExpenseValues
): Record<string, { mode: "blank" | "exact"; value?: number }> {
  const result: Record<string, { mode: "blank" | "exact"; value?: number }> = {};
  for (const key of EXPENSE_KEYS) {
    const value = values[key];
    result[key] = value === null
      ? { mode: "blank" }
      : { mode: "exact", value };
  }
  return result;
}

export function createSpreadsheetRowUrl(input: {
  spreadsheetId: string;
  sheetId: number;
  row: number;
  endColumn?: string;
}): string {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(input.spreadsheetId)) {
    throw new Error("スプレッドシートIDが不正です。");
  }
  if (!Number.isInteger(input.sheetId) || input.sheetId < 0) {
    throw new Error("シートIDが不正です。");
  }
  if (!Number.isInteger(input.row) || input.row < 1) {
    throw new Error("行番号が不正です。");
  }
  const endColumn = (input.endColumn ?? "BB").toUpperCase();
  if (!/^[A-Z]+$/.test(endColumn)) {
    throw new Error("終端列が不正です。");
  }
  return `https://docs.google.com/spreadsheets/d/${input.spreadsheetId}/edit#gid=${input.sheetId}&range=A${input.row}:${endColumn}${input.row}`;
}

export function canManuallyRetrySheetWrite(input: {
  status: string;
  errorType?: string;
}): boolean {
  if (!["blocked", "dead_letter", "retry_wait"].includes(input.status)) {
    return false;
  }
  return input.errorType !== "conflict";
}

function parseExpenseValue(raw: unknown): { value: number | null; error?: string } {
  if (raw === null || typeof raw === "undefined" || raw === "") {
    return { value: null };
  }

  const normalized = String(raw)
    .normalize("NFKC")
    .replace(/[¥￥円,\s　]/g, "")
    .trim();

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return { value: null, error: "0以上の数字で入力してください。" };
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) {
    return { value: null, error: "0以上の数字で入力してください。" };
  }
  if (value > 10_000_000) {
    return { value: null, error: "1,000万円以下で入力してください。" };
  }
  return { value };
}

function labelFor(key: keyof ExpenseValues): string {
  return ({
    transportation: "交通費",
    purchase8: "8%買取",
    purchase10: "10%買取",
    netPrintCost: "ネットプリント",
    postageCost: "切手・速達・レターパック",
  })[key];
}
