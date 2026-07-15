import {
  createCaseIdentity,
  createJobIdFromPersistedCaseId,
  isValidPersistedCaseId,
} from "./case-id";
import {
  ParsedShiftJob,
  SheetParseResult,
  ShiftColumnConfig,
  ShiftImportConfig,
} from "./shift-import-types";

const CANCELLATION_MARKER = /[（(]\s*キャンセル\s*[）)]/giu;

export function parseShiftSheet(
  spreadsheetId: string,
  sheetName: string,
  values: unknown[][],
  config: ShiftImportConfig,
  sheetId: number | null = null
): SheetParseResult {
  const headerRow = resolveHeaderRow(values, config);
  const dataStartRow = config.dataStartRow ?? (headerRow + 1);
  const jobs: ParsedShiftJob[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  const occurrenceMap = new Map<string, number>();

  for (let sheetRow = dataStartRow; sheetRow <= values.length; sheetRow++) {
    const row = values[sheetRow - 1] ?? [];
    const clientRaw = cellText(row, config.columns.clientName);

    // J列相当が空欄の黒い区切り行や空白行は読み込みません。
    if (!clientRaw) {
      skippedRows++;
      continue;
    }

    const dateRaw = cellText(row, config.columns.workDate);
    const dateKey = parseDateKey(dateRaw, sheetName);
    if (!dateKey) {
      skippedRows++;
      warnings.push(`${sheetName}!${sheetRow}: 実施日「${dateRaw}」を日付として読めません。`);
      continue;
    }

    const rawStaffName = cellText(row, config.columns.staffName);
    const rawClientName = clientRaw;
    const clientName = cleanCancellationMarker(rawClientName);
    const assignedStaffName = cleanCancellationMarker(rawStaffName);
    const storeName = cellText(row, config.columns.storeName);
    const makerName = cellText(row, config.columns.makerName);
    const rawMenuName = cellText(row, config.columns.menuName);
    const menu = splitMenuConditions(rawMenuName);
    const workTime = cellText(row, config.columns.workTime);
    const entryTime = cellText(row, config.columns.entryTime);
    const subcontractorName = cellText(row, config.columns.subcontractorName);

    const markerCancelled =
      CANCELLATION_MARKER.test(rawStaffName) ||
      CANCELLATION_MARKER.test(rawClientName);
    CANCELLATION_MARKER.lastIndex = 0;

    const explicitCancelled = markerCancelled ||
      isChecked(cellText(row, config.columns.cancelled));
    const recruitmentStopped = isChecked(
      cellText(row, config.columns.recruitmentStopped)
    );

    const requiredMissing = [
      ["店舗名", storeName],
      ["メーカー名", makerName],
      ["メニュー名", menu.name],
      ["実施時間", workTime],
    ].filter(([, value]) => !value).map(([label]) => label);

    const rowWarnings = requiredMissing.map(
      (label) => `${label}が空欄です。`
    );

    let status: ParsedShiftJob["status"];
    if (explicitCancelled) status = "cancelled";
    else if (recruitmentStopped) status = "stopped";
    else if (assignedStaffName) status = "assigned";
    else if (requiredMissing.length > 0) status = "draft";
    else status = "open";

    const publishable = status === "open" && requiredMissing.length === 0;

    const identityKey = [
      normalizeIdentity(dateKey),
      normalizeIdentity(clientName),
      normalizeIdentity(storeName),
      normalizeIdentity(workTime),
    ].join("|");

    const occurrence = (occurrenceMap.get(identityKey) ?? 0) + 1;
    occurrenceMap.set(identityKey, occurrence);

    const persistedCaseId = cellText(row, config.columns.caseId);
    const identity = persistedCaseId && isValidPersistedCaseId(persistedCaseId)
      ? {
          jobId: createJobIdFromPersistedCaseId(config.companyId, persistedCaseId),
          caseId: persistedCaseId,
          sourceIdentityKey: `persisted:${persistedCaseId}`,
          identityFingerprint: identityKey,
        }
      : createCaseIdentity({
          companyId: config.companyId,
          spreadsheetId,
          sheetName,
          dateKey,
          clientName,
          storeName,
          workTime,
          occurrence,
        });

    const temperature = cellText(row, config.columns.temperature);
    const arrivalTime = cellText(row, config.columns.arrivalTime);
    const cancellationReason =
      cellText(row, config.columns.cancellationReason) ||
      (markerCancelled ? "キャンセル" : "");

    jobs.push({
      ...identity,
      companyId: config.companyId,
      sourceOccurrence: occurrence,
      workDate: dateKey,
      dateKey,
      clientName,
      rawClientName,
      storeName,
      makerName,
      menuName: menu.name,
      menuConditions: menu.conditions,
      entryTime,
      workTime,
      subcontractorName,
      assignedStaffName,
      rawStaffName,
      status,
      publishable,
      recruitmentStopped,
      cancelled: explicitCancelled,
      cancellationReason,
      basePay: firstMoney(row, config.columns.basePayColumns ?? []),
      financials: {
        clientChargeTotal: moneyFromCell(row, config.columns.clientChargeTotal),
        clientChargeAdditionsTotal: sumMoney(row, config.columns.clientChargeAdditionColumns ?? []),
        staffPaymentTotal: moneyFromCell(row, config.columns.staffPaymentTotal),
        subcontractorTotal: moneyFromCell(row, config.columns.subcontractorTotal),
      },
      expenses: {
        transportation: moneyFromCell(row, config.columns.transportation),
        purchase8: moneyFromCell(row, config.columns.purchase8),
        purchase10: moneyFromCell(row, config.columns.purchase10),
        netPrintCost: moneyFromCell(row, config.columns.netPrintCost),
        postageCost: moneyFromCell(row, config.columns.postageCost),
      },
      preContact: temperature || arrivalTime ? {
        temperature,
        arrivalTime,
      } : null,
      sheetRef: {
        spreadsheetId,
        sheetId,
        sheetName,
        currentRow: sheetRow,
        headerRow,
      },
      importWarnings: rowWarnings,
    });
  }

  const counts = {
    open: jobs.filter((job) => job.status === "open").length,
    assigned: jobs.filter((job) => job.status === "assigned").length,
    stopped: jobs.filter((job) => job.status === "stopped").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
    draft: jobs.filter((job) => job.status === "draft").length,
  };

  return {
    jobs,
    summary: {
      sheetName,
      headerRow,
      dataStartRow,
      rowsRead: Math.max(0, values.length - dataStartRow + 1),
      jobsFound: jobs.length,
      skippedRows,
      counts,
      warnings: warnings.slice(0, 100),
    },
  };
}

function resolveHeaderRow(
  values: unknown[][],
  config: ShiftImportConfig
): number {
  if (config.headerRow && config.headerRow > 0) return config.headerRow;

  const maxScan = Math.min(values.length, 20);
  let bestRow = 1;
  let bestScore = -1;

  for (let index = 0; index < maxScan; index++) {
    const row = values[index] ?? [];
    const score = headerScore(row, config.columns);
    if (score > bestScore) {
      bestScore = score;
      bestRow = index + 1;
    }
  }

  if (bestScore < 3) {
    throw new Error(
      `${config.companyId}: 見出し行を自動判定できません。headerRowを設定してください。`
    );
  }

  return bestRow;
}

function headerScore(row: unknown[], columns: ShiftColumnConfig): number {
  const checks: Array<[string | undefined, RegExp]> = [
    [columns.workDate, /実施日|日付/u],
    [columns.staffName, /スタッフ|名前/u],
    [columns.clientName, /クライアント/u],
    [columns.storeName, /店舗/u],
    [columns.makerName, /メーカー/u],
    [columns.menuName, /メニュー/u],
    [columns.workTime, /実施時間|時間/u],
  ];

  return checks.reduce((score, [column, pattern]) => {
    const value = cellText(row, column);
    return score + (pattern.test(value) ? 1 : 0);
  }, 0);
}

function cellText(row: unknown[], column?: string): string {
  if (!column) return "";
  const index = columnLetterToIndex(column);
  const value = row[index];
  return String(value ?? "").trim();
}

function moneyFromCell(row: unknown[], column?: string): number | null {
  if (!column) return null;
  return parseMoney(cellText(row, column));
}

function sumMoney(row: unknown[], columns: string[]): number | null {
  let total = 0;
  let found = false;
  for (const column of columns) {
    const parsed = moneyFromCell(row, column);
    if (parsed !== null) {
      total += parsed;
      found = true;
    }
  }
  return found ? total : null;
}

function firstMoney(row: unknown[], columns: string[]): number | null {
  for (const column of columns) {
    const parsed = moneyFromCell(row, column);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function parseMoney(raw: string): number | null {
  if (!raw.trim()) return null;
  const normalized = raw
    .normalize("NFKC")
    .replace(/[¥￥円,\s　]/g, "")
    .replace(/[▲△]/g, "-");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseDateKey(raw: string, sheetName: string): string | null {
  const text = raw.normalize("NFKC").trim();
  if (!text) return null;

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const epoch = Date.UTC(1899, 11, 30);
      const date = new Date(epoch + Math.floor(serial) * 86400000);
      return formatIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }

  let match = /^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/.exec(text);
  if (match) {
    return validIso(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = /^(\d{1,2})[\/.-](\d{1,2})$/.exec(text);
  if (match) {
    const sheet = /^(\d{4})\.(\d{1,2})$/.exec(sheetName);
    if (!sheet) return null;
    return validIso(Number(sheet[1]), Number(match[1]), Number(match[2]));
  }

  match = /^(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (match) {
    const sheet = /^(\d{4})\.(\d{1,2})$/.exec(sheetName);
    if (!sheet) return null;
    return validIso(Number(sheet[1]), Number(match[1]), Number(match[2]));
  }

  return null;
}

function validIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return null;
  return formatIso(year, month, day);
}

function formatIso(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function splitMenuConditions(raw: string): { name: string; conditions: string[] } {
  const conditions: string[] = [];
  const name = raw.replace(/[（(]([^）)]+)[）)]/gu, (_whole, inner: string) => {
    const value = inner.trim();
    if (value) conditions.push(value);
    return "";
  }).replace(/[\s　]+/g, " ").trim();
  return { name, conditions };
}

function cleanCancellationMarker(value: string): string {
  CANCELLATION_MARKER.lastIndex = 0;
  return value.replace(CANCELLATION_MARKER, "").trim();
}

function isChecked(value: string): boolean {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return ["true", "1", "yes", "on", "済", "✓", "✔"].includes(normalized);
}

function columnLetterToIndex(column: string): number {
  const normalized = column.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`列記号が不正です: ${column}`);
  }
  let value = 0;
  for (const character of normalized) {
    value = value * 26 + (character.charCodeAt(0) - 64);
  }
  return value - 1;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]+/g, "").trim().toLowerCase();
}
