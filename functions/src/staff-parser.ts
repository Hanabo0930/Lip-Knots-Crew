import {
  createStaffId,
  isValidEmail,
  normalizePhone,
  normalizeStaffName,
  splitEmails,
} from "./staff-identity";
import {
  MergedStaffProfile,
  ParsedStaffRow,
  StaffImportConfig,
  StaffParseResult,
} from "./staff-import-types";

export function parseStaffSheet(
  spreadsheetId: string,
  sheetName: string,
  values: unknown[][],
  config: StaffImportConfig
): StaffParseResult {
  const headerRow = resolveHeaderRow(values, config);
  const dataStartRow = config.dataStartRow ?? (headerRow + 1);
  const rows: ParsedStaffRow[] = [];
  const summaryWarnings: string[] = [];
  let invalidEmailCount = 0;

  for (let sheetRow = dataStartRow; sheetRow <= values.length; sheetRow++) {
    const row = values[sheetRow - 1] ?? [];
    const displayName = cellText(row, config.columns.displayName);
    if (!displayName) continue;

    const normalizedName = normalizeStaffName(displayName);
    if (!normalizedName) continue;

    const emailCell = cellText(row, config.columns.email);
    const emailCandidates = splitEmails(emailCell);
    const emails = emailCandidates.filter(isValidEmail);
    const invalidEmails = emailCandidates.filter((email) => !isValidEmail(email));
    invalidEmailCount += invalidEmails.length;

    const warnings: string[] = [];
    if (!emails.length) warnings.push("有効なメールアドレスがありません。");
    if (invalidEmails.length) {
      warnings.push(`無効なメール: ${invalidEmails.join(" / ")}`);
    }

    const sourceArea = config.sheetAreas[sheetName] ?? sheetName;
    const manualInactive = isChecked(cellText(row, config.columns.manualInactive));

    rows.push({
      companyId: config.companyId,
      staffId: createStaffId(config.companyId, displayName),
      displayName: displayName.trim(),
      normalizedName,
      emails,
      invalidEmails,
      phone: normalizePhone(cellText(row, config.columns.phone)),
      homePrefecture: cellText(row, config.columns.homePrefecture),
      nearestStation: cellText(row, config.columns.nearestStation),
      birthDateRaw: cellText(row, config.columns.birthDate),
      areaLabel: sourceArea,
      manualInactive,
      rank: cellText(row, config.columns.rank) || "A",
      evaluationTags: splitTags(cellText(row, config.columns.evaluationTags)),
      evaluationMemo: cellText(row, config.columns.evaluationMemo),
      sourceRef: {
        spreadsheetId,
        sheetName,
        row: sheetRow,
        headerRow,
      },
      warnings,
    });
  }

  for (const row of rows) {
    for (const warning of row.warnings) {
      summaryWarnings.push(`${sheetName}!${row.sourceRef.row} ${row.displayName}: ${warning}`);
    }
  }

  return {
    rows,
    summary: {
      sheetName,
      headerRow,
      dataStartRow,
      rowsRead: Math.max(0, values.length - dataStartRow + 1),
      staffRows: rows.length,
      invalidEmailCount,
      warnings: summaryWarnings.slice(0, 100),
    },
  };
}

export function mergeStaffRows(rows: ParsedStaffRow[]): {
  profiles: MergedStaffProfile[];
  warnings: string[];
} {
  const grouped = new Map<string, ParsedStaffRow[]>();
  for (const row of rows) {
    const key = `${row.companyId}|${row.normalizedName}`;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  const profiles: MergedStaffProfile[] = [];
  const warnings: string[] = [];

  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;

    const conflictWarnings: string[] = [];
    const emails = unique(group.flatMap((row) => row.emails));
    const invalidEmails = unique(group.flatMap((row) => row.invalidEmails));
    const areaLabels = unique(group.map((row) => row.areaLabel).filter(Boolean));
    const evaluationTags = unique(group.flatMap((row) => row.evaluationTags));

    const phone = pickField(group, "phone", conflictWarnings, "電話番号");
    const homePrefecture = pickField(
      group,
      "homePrefecture",
      conflictWarnings,
      "自宅都道府県"
    );
    const nearestStation = pickField(
      group,
      "nearestStation",
      conflictWarnings,
      "最寄り駅"
    );
    const birthDateRaw = pickField(
      group,
      "birthDateRaw",
      conflictWarnings,
      "生年月日"
    );
    const rank = pickField(group, "rank", conflictWarnings, "ランク") || "A";
    const evaluationMemo = pickField(
      group,
      "evaluationMemo",
      conflictWarnings,
      "評価メモ"
    );

    if (group.length > 1) {
      warnings.push(
        `${first.displayName}: ${group.length}行を1アカウントへ統合しました。`
      );
    }

    for (const warning of conflictWarnings) {
      warnings.push(`${first.displayName}: ${warning}`);
    }

    profiles.push({
      companyId: first.companyId,
      staffId: first.staffId,
      displayName: first.displayName,
      normalizedName: first.normalizedName,
      emails,
      invalidEmails,
      primaryEmail: emails[0] ?? "",
      phone,
      homePrefecture,
      nearestStation,
      birthDateRaw,
      areaLabels,
      active: !group.every((row) => row.manualInactive),
      rank,
      evaluationTags,
      evaluationMemo,
      sourceRefs: group.map((row) => row.sourceRef),
      conflictWarnings,
    });
  }

  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));
  return { profiles, warnings };
}

function resolveHeaderRow(
  values: unknown[][],
  config: StaffImportConfig
): number {
  if (config.headerRow && config.headerRow > 0) return config.headerRow;

  const maxScan = Math.min(values.length, 20);
  let bestRow = 1;
  let bestScore = -1;

  for (let index = 0; index < maxScan; index++) {
    const row = values[index] ?? [];
    const score = headerScore(row, config);
    if (score > bestScore) {
      bestScore = score;
      bestRow = index + 1;
    }
  }

  if (bestScore < 2) {
    throw new Error(
      `${config.companyId}: スタッフ管理の見出し行を判定できません。headerRowを設定してください。`
    );
  }
  return bestRow;
}

function headerScore(row: unknown[], config: StaffImportConfig): number {
  const checks: Array<[string | undefined, RegExp]> = [
    [config.columns.displayName, /名前|氏名|スタッフ/u],
    [config.columns.email, /メール|アドレス/u],
    [config.columns.phone, /電話/u],
    [config.columns.nearestStation, /最寄/u],
    [config.columns.homePrefecture, /都道府県|住所/u],
  ];

  return checks.reduce((score, [column, pattern]) => {
    if (!column) return score;
    return score + (pattern.test(cellText(row, column)) ? 1 : 0);
  }, 0);
}

function cellText(row: unknown[], column?: string): string {
  if (!column) return "";
  const index = columnLetterToIndex(column);
  return String(row[index] ?? "").trim();
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

function isChecked(value: string): boolean {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return ["true", "1", "yes", "on", "済", "✓", "✔", "利用停止"].includes(normalized);
}

function splitTags(value: string): string[] {
  return unique(
    value
      .normalize("NFKC")
      .split(/[,，、;\n\r]+/u)
      .map((tag) => tag.trim())
      .filter(Boolean)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pickField<
  Key extends keyof Pick<
    ParsedStaffRow,
    "phone" | "homePrefecture" | "nearestStation" |
    "birthDateRaw" | "rank" | "evaluationMemo"
  >
>(
  rows: ParsedStaffRow[],
  key: Key,
  warnings: string[],
  label: string
): string {
  const values = unique(
    rows.map((row) => String(row[key] ?? "").trim()).filter(Boolean)
  );
  if (values.length > 1) {
    warnings.push(`${label}が複数あります: ${values.join(" / ")}`);
  }
  return values[0] ?? "";
}
