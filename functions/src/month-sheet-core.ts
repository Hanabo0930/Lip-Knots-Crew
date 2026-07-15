export type SheetMetaCore = {
  title: string;
  sheetId: number;
  hidden?: boolean;
  rowCount?: number;
  columnCount?: number;
  conditionalFormatCount?: number;
  protectedRangeCount?: number;
};

export type MonthCreationPlan = {
  targetMonth: string;
  sourceMonth: string;
  sourceSheetId: number;
  targetExists: boolean;
  inputColumns: string[];
  formulaColumns: string[];
  clearRanges: string[];
  warnings: string[];
};

export function buildMonthCreationPlan(input: {
  targetMonth: string;
  sourceMonth?: string | null;
  sheets: SheetMetaCore[];
  mutableColumns: string[];
  formulaColumns: string[];
  dataStartRow: number;
  maxRows: number;
}): MonthCreationPlan {
  const targetMonth = normalizeMonth(input.targetMonth);
  const visible = input.sheets.filter((sheet) => !sheet.hidden);
  const months = visible
    .map((sheet) => sheet.title)
    .filter((title) => /^\d{4}\.\d{1,2}$/.test(title))
    .sort((a, b) => monthNumber(a) - monthNumber(b));
  const targetExists = visible.some((sheet) => sheet.title === targetMonth);
  const sourceMonth = input.sourceMonth
    ? normalizeMonth(input.sourceMonth)
    : months.filter((month) => monthNumber(month) < monthNumber(targetMonth)).at(-1) ?? null;

  if (!sourceMonth) throw new Error("複製元にできる過去月タブがありません。");
  if (sourceMonth === targetMonth) throw new Error("複製元と作成先は別の月にしてください。");
  const source = visible.find((sheet) => sheet.title === sourceMonth);
  if (!source) throw new Error(`複製元タブ「${sourceMonth}」がありません。`);
  if (targetExists) throw new Error(`作成先タブ「${targetMonth}」は既に存在します。`);

  const formulaSet = new Set(input.formulaColumns.map(normalizeColumn));
  const inputColumns = [...new Set(input.mutableColumns.map(normalizeColumn))]
    .filter((column) => !formulaSet.has(column))
    .sort((a, b) => columnNumber(a) - columnNumber(b));

  if (!inputColumns.length) throw new Error("初期化する入力列がありません。");
  if (input.dataStartRow < 1 || input.maxRows < input.dataStartRow) {
    throw new Error("初期化する行範囲が正しくありません。");
  }

  const clearRanges = compactColumnRanges(inputColumns).map(
    ([start, end]) =>
      `'${targetMonth.replace(/'/g, "''")}'!${start}${input.dataStartRow}:${end}${input.maxRows}`
  );

  const warnings: string[] = [];
  if ((source.protectedRangeCount ?? 0) === 0) {
    warnings.push("複製元タブに保護範囲が見つかりません。");
  }
  if ((source.conditionalFormatCount ?? 0) === 0) {
    warnings.push("複製元タブに条件付き書式が見つかりません。");
  }

  return {
    targetMonth,
    sourceMonth,
    sourceSheetId: source.sheetId,
    targetExists,
    inputColumns,
    formulaColumns: [...formulaSet],
    clearRanges,
    warnings,
  };
}

export function compactColumnRanges(columns: string[]): Array<[string, string]> {
  if (!columns.length) return [];
  const sorted = [...new Set(columns.map(normalizeColumn))]
    .sort((a, b) => columnNumber(a) - columnNumber(b));
  const ranges: Array<[string, string]> = [];
  let start = sorted[0]!;
  let previous = start;

  for (const column of sorted.slice(1)) {
    if (columnNumber(column) === columnNumber(previous) + 1) {
      previous = column;
      continue;
    }
    ranges.push([start, previous]);
    start = column;
    previous = column;
  }
  ranges.push([start, previous]);
  return ranges;
}

export function formulaSampleRows(
  dataStartRow: number,
  maxRows: number,
  sampleCount = 5
): number[] {
  if (maxRows < dataStartRow) return [];
  const available = maxRows - dataStartRow + 1;
  const count = Math.min(Math.max(sampleCount, 1), available);
  if (count === 1) return [dataStartRow];

  const rows = new Set<number>([dataStartRow, maxRows]);
  for (let index = 1; index < count - 1; index++) {
    rows.add(Math.round(
      dataStartRow + (available - 1) * (index / (count - 1))
    ));
  }
  return [...rows].sort((a, b) => a - b);
}

export function compareMonthMetadata(
  source: {
    conditionalFormatCount: number;
    protectedRangeCount: number;
    rowCount: number;
    columnCount: number;
  },
  target: {
    conditionalFormatCount: number;
    protectedRangeCount: number;
    rowCount: number;
    columnCount: number;
  }
): string[] {
  const errors: string[] = [];
  if (source.conditionalFormatCount !== target.conditionalFormatCount) {
    errors.push("条件付き書式の件数が複製元と一致しません。");
  }
  if (source.protectedRangeCount !== target.protectedRangeCount) {
    errors.push("保護範囲の件数が複製元と一致しません。");
  }
  if (source.rowCount !== target.rowCount) {
    errors.push("行数が複製元と一致しません。");
  }
  if (source.columnCount !== target.columnCount) {
    errors.push("列数が複製元と一致しません。");
  }
  return errors;
}

export function compareFormulaSamples(
  source: Record<string, string>,
  target: Record<string, string>
): string[] {
  const errors: string[] = [];
  for (const [cell, sourceFormula] of Object.entries(source)) {
    if (!sourceFormula.startsWith("=")) continue;
    const targetFormula = target[cell] ?? "";
    if (targetFormula !== sourceFormula) {
      errors.push(`${cell}の数式が複製元と一致しません。`);
    }
  }
  return errors;
}

export function normalizeMonth(value: string): string {
  const text = value.normalize("NFKC").trim();
  const match = /^(\d{4})[./-](\d{1,2})$/.exec(text) ??
    /^(\d{4})年(\d{1,2})月$/.exec(text);
  if (!match) throw new Error("月はYYYY.M形式で入力してください。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("月が正しくありません。");
  return `${year}.${month}`;
}

function normalizeColumn(value: string): string {
  const column = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(column)) throw new Error(`列記号が不正です: ${value}`);
  return column;
}

function columnNumber(value: string): number {
  return [...normalizeColumn(value)].reduce(
    (total, character) => total * 26 + character.charCodeAt(0) - 64,
    0
  );
}

function monthNumber(value: string): number {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(value);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 12 + Number(match[2]);
}
