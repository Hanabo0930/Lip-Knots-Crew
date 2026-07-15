export type FindingStatus =
  | "open"
  | "in_progress"
  | "fixed"
  | "accepted_risk"
  | "false_positive";

export type RemediationItem = {
  findingId: string;
  status: FindingStatus;
  owner: string;
  note: string;
  fixedInFile?: string;
  fixedAt?: string;
};

export type AuditDelta = {
  resolved: string[];
  newlyDetected: string[];
  unchanged: string[];
  blockerDelta: number;
  scoreDelta: number;
};

export function compareAuditFindings(
  before: {
    findings: Array<{ id: string; risk: string; title: string }>;
    blockers: number;
    score: number;
  },
  after: {
    findings: Array<{ id: string; risk: string; title: string }>;
    blockers: number;
    score: number;
  }
): AuditDelta {
  const beforeIds = new Set(before.findings.map((finding) => finding.id));
  const afterIds = new Set(after.findings.map((finding) => finding.id));

  return {
    resolved: [...beforeIds].filter((id) => !afterIds.has(id)),
    newlyDetected: [...afterIds].filter((id) => !beforeIds.has(id)),
    unchanged: [...beforeIds].filter((id) => afterIds.has(id)),
    blockerDelta: after.blockers - before.blockers,
    scoreDelta: after.score - before.score,
  };
}

export function remediationProgress(
  findings: Array<{ id: string; risk: string }>,
  remediations: RemediationItem[]
): {
  total: number;
  resolved: number;
  blockersOpen: number;
  percent: number;
} {
  const byId = new Map(
    remediations.map((item) => [item.findingId, item])
  );
  let resolved = 0;
  let blockersOpen = 0;

  for (const finding of findings) {
    const status = byId.get(finding.id)?.status ?? "open";
    const isResolved = [
      "fixed", "accepted_risk", "false_positive",
    ].includes(status);
    if (isResolved) resolved++;
    if (
      ["critical", "high"].includes(finding.risk) &&
      !isResolved
    ) blockersOpen++;
  }

  const total = findings.length;
  return {
    total,
    resolved,
    blockersOpen,
    percent: total ? Math.round((resolved / total) * 100) : 100,
  };
}

export function markdownAuditReport(input: {
  title: string;
  grade: string;
  score: number;
  blockers: number;
  findings: Array<{
    filename?: string;
    line: number;
    risk: string;
    title: string;
    evidence: string;
    recommendation: string;
    affectedColumns?: string[];
  }>;
}): string {
  const lines = [
    `# ${input.title}`,
    "",
    `- 評価: **${input.grade}**`,
    `- スコア: **${input.score}**`,
    `- 重大・高リスク未解決: **${input.blockers}件**`,
    "",
    "## 指摘一覧",
    "",
  ];

  input.findings.forEach((finding, index) => {
    lines.push(
      `### ${index + 1}. [${finding.risk.toUpperCase()}] ${finding.title}`,
      "",
      `- ファイル: ${finding.filename ?? "不明"}`,
      `- 行: ${finding.line}`,
      `- 影響列: ${(finding.affectedColumns ?? []).join("・") || "不明"}`,
      `- 証拠: \`${finding.evidence.replace(/`/g, "'")}\``,
      `- 修正案: ${finding.recommendation}`,
      ""
    );
  });

  return lines.join("\n");
}
