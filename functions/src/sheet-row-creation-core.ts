export type GridRangeLike = {
  sheetId?: number | null;
  startRowIndex?: number | null;
  endRowIndex?: number | null;
  startColumnIndex?: number | null;
  endColumnIndex?: number | null;
};

export type ConditionalRuleLike = {
  ranges?: GridRangeLike[] | null;
  booleanRule?: unknown;
  gradientRule?: unknown;
};

export type RowCreationConfigCore = {
  dataStartRow: number;
  maxRows: number;
  rowEndColumn: string;
  templateFormulaColumns: string[];
  requiredValidationColumns: string[];
};

export type RowScanInput = {
  rowNumber: number;
  workDate: unknown;
  clientName: unknown;
  storeName: unknown;
  workTime: unknown;
};

export type InsertPlan = {
  lastDataRow: number;
  templateRow: number;
  insertBeforeRow: number;
  insertedRows: number[];
};

export function monthSheetName(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`日付形式が不正です: ${dateKey}`);
  return `${match[1]}.${Number(match[2])}`;
}

export function buildInsertPlan(
  rows: RowScanInput[],
  count: number,
  config: RowCreationConfigCore
): InsertPlan {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("追加行数は1～20行で指定してください。");
  }
  const candidates = rows
    .filter((row) => row.rowNumber >= config.dataStartRow)
    .filter((row) => isDataRow(row))
    .filter((row) => row.rowNumber <= config.maxRows);

  if (!candidates.length) {
    throw new Error("雛形にできる既存案件行が見つかりません。");
  }

  const lastDataRow = Math.max(...candidates.map((row) => row.rowNumber));
  const templateRow = lastDataRow;
  const insertBeforeRow = lastDataRow + 1;
  const insertedRows = Array.from({ length: count }, (_, index) => insertBeforeRow + index);

  return {
    lastDataRow,
    templateRow,
    insertBeforeRow,
    insertedRows,
  };
}

export function isDataRow(row: RowScanInput): boolean {
  const workDate = normalize(row.workDate);
  const clientName = normalize(row.clientName);
  const storeName = normalize(row.storeName);
  const workTime = normalize(row.workTime);

  // J列相当が空欄の黒い区切り行、見出し、完全空白行を除外します。
  if (!clientName) return false;
  if (/クライアント名|クライアント/u.test(clientName)) return false;
  return Boolean(workDate || storeName || workTime);
}

export function gridRangeCoversRow(
  range: GridRangeLike,
  rowNumber: number
): boolean {
  const rowIndex = rowNumber - 1;
  const start = range.startRowIndex ?? 0;
  const end = range.endRowIndex ?? Number.MAX_SAFE_INTEGER;
  return rowIndex >= start && rowIndex < end;
}

export function conditionalRulesCoveringTemplate(
  rules: ConditionalRuleLike[],
  templateRow: number
): ConditionalRuleLike[] {
  return rules.flatMap((rule) => {
    const coveringRanges = (rule.ranges ?? []).filter(
      (range) => gridRangeCoversRow(range, templateRow)
    );
    if (!coveringRanges.length) return [];
    return [{ ...rule, ranges: coveringRanges }];
  });
}

export function missingConditionalRulesForRows(
  templateRules: ConditionalRuleLike[],
  allRulesAfterInsert: ConditionalRuleLike[],
  insertedRows: number[]
): Array<{ templateRule: ConditionalRuleLike; rowNumber: number }> {
  const missing: Array<{ templateRule: ConditionalRuleLike; rowNumber: number }> = [];

  templateRules.forEach((templateRule) => {
    const signature = conditionalRuleSignature(templateRule);
    insertedRows.forEach((rowNumber) => {
      const covered = allRulesAfterInsert.some((candidate) =>
        conditionalRuleSignature(candidate) === signature &&
        (candidate.ranges ?? []).some((range) => gridRangeCoversRow(range, rowNumber))
      );
      if (!covered) missing.push({ templateRule, rowNumber });
    });
  });

  return missing;
}

export function cloneConditionalRuleForRow(
  rule: ConditionalRuleLike,
  sheetId: number,
  rowNumber: number,
  maxColumnIndex: number
): ConditionalRuleLike {
  const clonedRanges = (rule.ranges ?? []).map((range) => ({
    sheetId,
    startRowIndex: rowNumber - 1,
    endRowIndex: rowNumber,
    startColumnIndex: range.startColumnIndex ?? 0,
    endColumnIndex: range.endColumnIndex ?? maxColumnIndex,
  }));
  const cloned: ConditionalRuleLike = {
    ranges: clonedRanges.length ? clonedRanges : [{
      sheetId,
      startRowIndex: rowNumber - 1,
      endRowIndex: rowNumber,
      startColumnIndex: 0,
      endColumnIndex: maxColumnIndex,
    }],
  };
  if (rule.booleanRule !== undefined) cloned.booleanRule = rule.booleanRule;
  if (rule.gradientRule !== undefined) cloned.gradientRule = rule.gradientRule;
  return cloned;
}

export function formulaVerification(
  values: Record<string, unknown>,
  formulaColumns: string[]
): string[] {
  return formulaColumns
    .filter((column) => !String(values[column] ?? "").trim().startsWith("="))
    .map((column) => `${column}列へ数式が継承されていません。`);
}

export function validationVerification(
  validations: Record<string, boolean>,
  requiredColumns: string[]
): string[] {
  return requiredColumns
    .filter((column) => validations[column] !== true)
    .map((column) => `${column}列へ入力規則が継承されていません。`);
}

export function buildRowFingerprint(input: {
  workDate: unknown;
  clientName: unknown;
  storeName: unknown;
  workTime: unknown;
  caseId: unknown;
}): string {
  return [
    normalize(input.workDate),
    normalize(input.clientName),
    normalize(input.storeName),
    normalize(input.workTime),
    normalize(input.caseId),
  ].join("|");
}

export function columnToIndex(column: string): number {
  const normalized = column.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) throw new Error(`列記号が不正です: ${column}`);
  let number = 0;
  for (const character of normalized) {
    number = number * 26 + character.charCodeAt(0) - 64;
  }
  return number - 1;
}

export function indexToColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("列番号が不正です。");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function conditionalRuleSignature(rule: ConditionalRuleLike): string {
  return JSON.stringify({
    booleanRule: rule.booleanRule ?? null,
    gradientRule: rule.gradientRule ?? null,
  });
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .trim()
    .toLowerCase();
}
