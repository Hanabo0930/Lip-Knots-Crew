export type HeaderAliasMap = Record<string, string[]>;

export type HeaderDetection = {
  headerRow: number;
  score: number;
  columns: Record<string, string>;
  missingRequired: string[];
};

export type MonthDescriptorCore = {
  title: string;
  hidden?: boolean;
};

const shiftAliases: HeaderAliasMap = {
  workDate: ["実施日", "日付", "稼働日"],
  staffName: ["スタッフ名", "スタッフ", "氏名", "名前"],
  temperature: ["体温"],
  arrivalTime: ["着時刻", "到着時刻", "到着予定"],
  clientName: ["クライアント名", "クライアント", "依頼元"],
  storeName: ["店舗名", "店舗", "店名"],
  makerName: ["メーカー名", "メーカー"],
  menuName: ["メニュー名", "メニュー", "商品"],
  entryTime: ["入店時間", "入店"],
  workTime: ["実施時間", "稼働時間", "勤務時間"],
  subcontractorName: ["外注名", "外注"],
  caseId: ["案件ID", "案件ＩＤ", "caseid"],
};

const staffAliases: HeaderAliasMap = {
  displayName: ["氏名", "名前", "スタッフ名", "スタッフ"],
  homePrefecture: ["自宅都道府県", "都道府県", "住所"],
  nearestStation: ["最寄り駅", "最寄駅", "最寄"],
  birthDate: ["生年月日", "誕生日"],
  email: ["メールアドレス", "メール", "mail"],
  phone: ["電話番号", "電話", "携帯番号", "携帯"],
};

export function extractSpreadsheetId(value: string): string {
  const text = value.trim();
  if (/^[a-zA-Z0-9-_]{20,}$/.test(text)) return text;
  const urlMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(text);
  if (urlMatch?.[1]) return urlMatch[1];
  throw new Error("GoogleスプレッドシートのURLまたはIDを確認してください。");
}

export function columnToLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("列番号が正しくありません。");
  }
  let current = index + 1;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

export function detectShiftHeader(
  rows: unknown[][],
  maxRows = 20
): HeaderDetection {
  return detectHeader(rows, shiftAliases, [
    "workDate", "clientName", "storeName", "makerName", "menuName", "workTime",
  ], maxRows);
}

export function detectStaffHeader(
  rows: unknown[][],
  maxRows = 20
): HeaderDetection {
  return detectHeader(rows, staffAliases, ["displayName", "email"], maxRows);
}

export function detectHeader(
  rows: unknown[][],
  aliases: HeaderAliasMap,
  required: string[],
  maxRows = 20
): HeaderDetection {
  let best: HeaderDetection = {
    headerRow: 1,
    score: -1,
    columns: {},
    missingRequired: [...required],
  };

  rows.slice(0, maxRows).forEach((row, rowIndex) => {
    const columns: Record<string, string> = {};
    let score = 0;

    row.forEach((rawCell, columnIndex) => {
      const cell = normalizeHeader(rawCell);
      if (!cell) return;
      for (const [key, candidates] of Object.entries(aliases)) {
        if (columns[key]) continue;
        if (candidates.some((candidate) => headerMatches(cell, candidate))) {
          columns[key] = columnToLetter(columnIndex);
          score += required.includes(key) ? 3 : 1;
        }
      }
    });

    const missingRequired = required.filter((key) => !columns[key]);
    if (
      score > best.score ||
      (score === best.score && missingRequired.length < best.missingRequired.length)
    ) {
      best = {
        headerRow: rowIndex + 1,
        score,
        columns,
        missingRequired,
      };
    }
  });

  return best;
}

export function monthlySheets(
  sheets: MonthDescriptorCore[],
  pattern = /^\d{4}\.\d{1,2}$/
): string[] {
  return sheets
    .filter((sheet) => !sheet.hidden)
    .map((sheet) => sheet.title)
    .filter((title) => pattern.test(title))
    .sort((a, b) => monthNumber(a) - monthNumber(b));
}

export function previousMonthSheet(
  targetMonth: string,
  availableMonths: string[]
): string | null {
  const target = monthNumber(targetMonth);
  const previous = availableMonths
    .filter((month) => monthNumber(month) < target)
    .sort((a, b) => monthNumber(b) - monthNumber(a));
  return previous[0] ?? null;
}

export function nextMonthName(sourceMonth: string): string {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(sourceMonth);
  if (!match) throw new Error("月タブ名はYYYY.M形式で指定してください。");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}`;
}

export function normalizeMonthName(value: string): string {
  const text = value.normalize("NFKC").trim();
  let match = /^(\d{4})[./-](\d{1,2})$/.exec(text);
  if (!match) {
    match = /^(\d{4})年(\d{1,2})月$/.exec(text);
  }
  if (!match) throw new Error("対象月はYYYY.M形式で入力してください。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("対象月が正しくありません。");
  return `${year}.${month}`;
}

export function buildSafeDraft(input: {
  companyId: string;
  shiftSpreadsheetId: string;
  staffSpreadsheetId: string;
  shiftHeader: HeaderDetection;
  staffHeader: HeaderDetection;
  monthlySheetPattern?: string;
  staffActiveSheets?: string[];
  staffExcludedSheets?: string[];
  idColumn?: string;
}): Record<string, unknown> {
  const idColumn = input.shiftHeader.columns.caseId || input.idColumn || "ZZ";
  const shiftColumns = {
    workDate: input.shiftHeader.columns.workDate || "A",
    staffName: input.shiftHeader.columns.staffName || "B",
    temperature: input.shiftHeader.columns.temperature || "G",
    arrivalTime: input.shiftHeader.columns.arrivalTime || "H",
    clientName: input.shiftHeader.columns.clientName || "J",
    storeName: input.shiftHeader.columns.storeName || "K",
    makerName: input.shiftHeader.columns.makerName || "L",
    menuName: input.shiftHeader.columns.menuName || "M",
    entryTime: input.shiftHeader.columns.entryTime || "N",
    workTime: input.shiftHeader.columns.workTime || "O",
    subcontractorName: input.shiftHeader.columns.subcontractorName || "P",
    caseId: idColumn,
  };

  return {
    companyId: input.companyId,
    safety: {
      allEnabled: false,
      generatedAt: new Date().toISOString(),
      note: "ウィザード生成。検証コピーで確認するまで全機能OFF。",
    },
    shiftImportConfig: {
      enabled: false,
      scheduleEnabled: false,
      spreadsheetId: input.shiftSpreadsheetId,
      monthlySheetPattern: input.monthlySheetPattern || "^\\d{4}\\.\\d{1,2}$",
      headerRow: input.shiftHeader.headerRow,
      dataStartRow: input.shiftHeader.headerRow + 1,
      readRangeEndColumn: idColumn,
      columns: shiftColumns,
    },
    staffImportConfig: {
      enabled: false,
      scheduleEnabled: false,
      spreadsheetId: input.staffSpreadsheetId,
      activeSheets: input.staffActiveSheets || ["マスタ", "東北"],
      excludedSheets: input.staffExcludedSheets || ["抹消"],
      headerRow: input.staffHeader.headerRow,
      dataStartRow: input.staffHeader.headerRow + 1,
      readRangeEndColumn: "T",
      columns: {
        displayName: input.staffHeader.columns.displayName || "B",
        homePrefecture: input.staffHeader.columns.homePrefecture || "G",
        nearestStation: input.staffHeader.columns.nearestStation || "P",
        birthDate: input.staffHeader.columns.birthDate || "Q",
        email: input.staffHeader.columns.email || "S",
        phone: input.staffHeader.columns.phone || "T",
      },
    },
    shiftMapping: {
      enabled: false,
      spreadsheetId: input.shiftSpreadsheetId,
      idColumn,
      columns: shiftColumns,
      identityColumns: {
        workDate: shiftColumns.workDate,
        clientName: shiftColumns.clientName,
        storeName: shiftColumns.storeName,
        workTime: shiftColumns.workTime,
      },
      rowCreation: {
        enabled: false,
        headerRow: input.shiftHeader.headerRow,
        dataStartRow: input.shiftHeader.headerRow + 1,
        rowEndColumn: idColumn,
        formulaColumns: ["AA", "AJ", "AR", "BB"],
        requiredValidationColumns: [],
        copyFormat: true,
        copyFormula: true,
        copyDataValidation: true,
        cloneConditionalFormatting: true,
        rollbackOnVerificationFailure: true,
      },
      monthCreation: {
        enabled: false,
        preserveFormatting: true,
        preserveProtectedRanges: true,
        rollbackOnVerificationFailure: true,
      },
    },
    companyFeatureSettings: {
      adminJobCreationSourceReady: false,
      monthSheetCreationReady: false,
      pilotMode: true,
    },
  };
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .trim()
    .toLowerCase();
}

function headerMatches(cell: string, candidate: string): boolean {
  const normalized = normalizeHeader(candidate);
  return cell === normalized || cell.includes(normalized);
}

function monthNumber(value: string): number {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(value);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 12 + Number(match[2]);
}
