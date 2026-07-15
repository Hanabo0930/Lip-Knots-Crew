export type PatchKind =
  | "header_mapping"
  | "lock_service"
  | "audit_log"
  | "safe_clear"
  | "formula_guard"
  | "mail_idempotency"
  | "trigger_guard"
  | "manual";

export type PatchSuggestion = {
  id: string;
  findingId: string;
  filename: string;
  line: number;
  kind: PatchKind;
  confidence: "high" | "medium" | "low";
  title: string;
  explanation: string;
  before: string;
  after: string;
  notes: string[];
  autoApplicable: boolean;
};

export type PatchPlan = {
  suggestions: PatchSuggestion[];
  autoApplicableCount: number;
  manualReviewCount: number;
};

export function generatePatchPlan(input: {
  files: Array<{ filename: string; source: string }>;
  findings: Array<{
    id: string;
    filename?: string;
    line: number;
    category: string;
    evidence: string;
    affectedColumns?: string[];
  }>;
}): PatchPlan {
  const fileMap = new Map(input.files.map((file) => [file.filename, file.source]));
  const suggestions: PatchSuggestion[] = [];

  for (const finding of input.findings) {
    const filename = finding.filename ?? "";
    const source = fileMap.get(filename);
    if (!source) continue;
    const lineText = source.split(/\r?\n/)[Math.max(0, finding.line - 1)] ?? "";

    const suggestion = suggestionForFinding(
      finding,
      filename,
      lineText
    );
    if (suggestion) suggestions.push(suggestion);
  }

  return {
    suggestions,
    autoApplicableCount: suggestions.filter((item) => item.autoApplicable).length,
    manualReviewCount: suggestions.filter((item) => !item.autoApplicable).length,
  };
}

export function applySafePatches(input: {
  source: string;
  suggestions: PatchSuggestion[];
}): {
  source: string;
  applied: string[];
  skipped: string[];
} {
  let source = input.source;
  const applied: string[] = [];
  const skipped: string[] = [];

  const sorted = [...input.suggestions]
    .filter((item) => item.autoApplicable)
    .sort((a, b) => b.line - a.line);

  for (const suggestion of sorted) {
    if (!suggestion.before || !source.includes(suggestion.before)) {
      skipped.push(suggestion.id);
      continue;
    }
    source = source.replace(suggestion.before, suggestion.after);
    applied.push(suggestion.id);
  }

  return { source, applied, skipped };
}

export function unifiedDiff(
  filename: string,
  before: string,
  after: string
): string {
  if (before === after) return `--- a/${filename}\n+++ b/${filename}\n`;
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const output = [`--- a/${filename}`, `+++ b/${filename}`];

  for (let index = 0; index < max; index++) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) {
      if (left !== undefined) output.push(` ${left}`);
      continue;
    }
    if (left !== undefined) output.push(`-${left}`);
    if (right !== undefined) output.push(`+${right}`);
  }
  return output.join("\n");
}

function suggestionForFinding(
  finding: {
    id: string;
    line: number;
    category: string;
    evidence: string;
    affectedColumns?: string[];
  },
  filename: string,
  lineText: string
): PatchSuggestion | null {
  const base = {
    id: `patch_${finding.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    findingId: finding.id,
    filename,
    line: finding.line,
    before: lineText,
  };

  if (finding.category === "numeric_column") {
    const match = /\.getRange\s*\(\s*([^,]+)\s*,\s*(\d+)([^)]*)\)/.exec(lineText);
    if (!match) return manual(base, "固定列番号を列マッピングへ変更", lineText);
    const rowExpr = match[1]?.trim() ?? "row";
    const columnNumber = Number(match[2]);
    const column = indexToColumn(columnNumber - 1);
    const tail = match[3] ?? "";
    const replacement =
      `.getRange(${rowExpr}, getColumnByHeader_(sheet, "${column}")${tail})`;
    return {
      ...base,
      kind: "header_mapping",
      confidence: "medium",
      title: "固定列番号をヘッダー解決へ置換",
      explanation: `${column}列の固定番号を、見出し名・設定マッピングから解決する方式へ変更します。`,
      after: lineText.replace(match[0], replacement),
      notes: [
        "getColumnByHeader_の実装と実際のヘッダー名は手動確認が必要です。",
        "請求・給与列の場合は旧版との差額0円を確認してください。",
      ],
      autoApplicable: false,
    };
  }

  if (finding.category === "hardcoded_a1") {
    const match = /(["'`])(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\1/.exec(lineText);
    if (!match) return manual(base, "A1固定参照をマッピングへ変更", lineText);
    const range = match[2] ?? "";
    return {
      ...base,
      kind: "header_mapping",
      confidence: "low",
      title: "A1固定参照を安全な範囲解決へ変更",
      explanation: `${range}を直接参照せず、案件IDやヘッダー名から範囲を作ります。`,
      after: lineText.replace(match[0], `buildSafeRange_(sheet, "${range}")`),
      notes: [
        "元の行番号が固定でよい処理か確認してください。",
        "数式セルを含む場合は自動適用しません。",
      ],
      autoApplicable: false,
    };
  }

  if (finding.category === "lock_missing") {
    return {
      ...base,
      kind: "lock_service",
      confidence: "high",
      title: "排他ロックを追加",
      explanation: "同時実行による二重書込を防ぐため、関数の入口とfinallyへLockServiceを追加します。",
      before: "",
      after: lockTemplate(),
      notes: [
        "対象関数を特定してテンプレートを組み込んでください。",
        "tryLockの待機時間は処理時間に合わせて調整します。",
      ],
      autoApplicable: false,
    };
  }

  if (finding.category === "clear") {
    return {
      ...base,
      kind: "safe_clear",
      confidence: "medium",
      title: "clear対象を入力列だけに限定",
      explanation: "数式・入力規則・書式を消さないよう、許可列だけを個別にclearContentします。",
      after: lineText.replace(
        /\.(?:clear|clearContent|clearFormat)\s*\(\s*\)/,
        ".clearContent() /* TODO: 許可済み入力列の範囲だけに限定 */"
      ),
      notes: [
        "元の範囲が入力セルだけか確認してください。",
        "clearFormatは自動置換しません。",
      ],
      autoApplicable: /\.clearContent\s*\(\s*\)/.test(lineText),
    };
  }

  if (finding.category === "formula_write") {
    return {
      ...base,
      kind: "formula_guard",
      confidence: "medium",
      title: "数式書込後の検算を追加",
      explanation: "書込直後に数式文字列を再取得し、期待値と一致しなければ停止します。",
      after: `${lineText}\nverifyFormulaAfterWrite_(range, expectedFormula);`,
      notes: [
        "expectedFormulaの生成方法を元コードに合わせて調整してください。",
      ],
      autoApplicable: false,
    };
  }

  if (finding.category === "mail_send") {
    return {
      ...base,
      kind: "mail_idempotency",
      confidence: "medium",
      title: "メール二重送信防止を追加",
      explanation: "案件ID・送信種別・対象月から冪等キーを作り、送信済みならスキップします。",
      after: `if (!alreadySent_(idempotencyKey)) {\n  ${lineText.trim()}\n  markSent_(idempotencyKey);\n}`,
      notes: [
        "送信済み台帳の保存先を決めてください。",
        "検証環境では実宛先を無効化してください。",
      ],
      autoApplicable: false,
    };
  }

  if (finding.category === "trigger") {
    return {
      ...base,
      kind: "trigger_guard",
      confidence: "high",
      title: "検証環境ガードを追加",
      explanation: "検証コピーでは本番トリガー作成・削除を行わないよう環境判定を追加します。",
      after: `if (getEnvironment_() !== "production") return;\n${lineText}`,
      notes: [
        "本番・検証の判定値はスクリプトプロパティのキー名だけを使用してください。",
      ],
      autoApplicable: false,
    };
  }

  return manual(base, "手動レビューが必要", lineText);
}

function manual(
  base: {
    id: string;
    findingId: string;
    filename: string;
    line: number;
    before: string;
  },
  title: string,
  lineText: string
): PatchSuggestion {
  return {
    ...base,
    kind: "manual",
    confidence: "low",
    title,
    explanation: "周辺コードと実データ依存を確認して修正します。",
    before: lineText,
    after: lineText,
    notes: ["自動適用しません。"],
    autoApplicable: false,
  };
}

function lockTemplate(): string {
  return [
    "const lock = LockService.getScriptLock();",
    "if (!lock.tryLock(30000)) {",
    '  throw new Error("別の処理が実行中です。");',
    "}",
    "try {",
    "  // 既存処理",
    "} finally {",
    "  lock.releaseLock();",
    "}",
  ].join("\n");
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
