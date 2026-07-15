export type SecretRisk = "critical" | "high" | "medium";

export type SecretFinding = {
  id: string;
  filename: string;
  line: number;
  risk: SecretRisk;
  category:
    | "private_key"
    | "oauth_token"
    | "api_key"
    | "password"
    | "webhook"
    | "email"
    | "phone"
    | "script_property_value";
  label: string;
  evidenceMasked: string;
  recommendation: string;
};

export type SecretScanReport = {
  safeToUpload: boolean;
  findings: SecretFinding[];
  summary: Record<SecretRisk, number>;
};

export function scanSourcesForSecrets(
  files: Array<{ filename: string; source: string }>
): SecretScanReport {
  const findings: SecretFinding[] = [];

  for (const file of files) {
    const lines = file.source.replace(/\r\n/g, "\n").split("\n");
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      scanLine(file.filename, line, lineNumber, findings);
    });
  }

  const deduped = [...new Map(
    findings.map((finding) => [
      `${finding.filename}|${finding.line}|${finding.category}|${finding.evidenceMasked}`,
      finding,
    ])
  ).values()];

  const summary: Record<SecretRisk, number> = {
    critical: 0,
    high: 0,
    medium: 0,
  };
  deduped.forEach((finding) => summary[finding.risk]++);

  return {
    safeToUpload: summary.critical === 0 && summary.high === 0,
    findings: deduped,
    summary,
  };
}

export function redactSource(
  source: string,
  findings: SecretFinding[],
  filename: string
): string {
  const riskyLines = new Map<number, SecretFinding[]>();
  findings
    .filter((finding) => finding.filename === filename)
    .forEach((finding) => {
      const current = riskyLines.get(finding.line) ?? [];
      current.push(finding);
      riskyLines.set(finding.line, current);
    });

  return source.replace(/\r\n/g, "\n").split("\n").map((line, index) => {
    const lineFindings = riskyLines.get(index + 1) ?? [];
    let result = line;
    for (const finding of lineFindings) {
      if (finding.category === "email" || finding.category === "phone") continue;
      result = redactAssignment(result);
      result = result.replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*/g,
        "/* [PRIVATE KEY REMOVED] */"
      );
    }
    return result;
  }).join("\n");
}

function scanLine(
  filename: string,
  line: string,
  lineNumber: number,
  output: SecretFinding[]
): void {
  const patterns: Array<{
    pattern: RegExp;
    category: SecretFinding["category"];
    risk: SecretRisk;
    label: string;
    recommendation: string;
  }> = [
    {
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      category: "private_key",
      risk: "critical",
      label: "秘密鍵が含まれています",
      recommendation: "コードから削除し、Secret Managerまたはスクリプトプロパティへ移してください。",
    },
    {
      pattern: /\b(?:ya29\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
      category: "oauth_token",
      risk: "critical",
      label: "アクセストークンらしき値があります",
      recommendation: "値を無効化・再発行し、監査用コードから削除してください。",
    },
    {
      pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/,
      category: "api_key",
      risk: "high",
      label: "Google APIキーらしき値があります",
      recommendation: "値を伏せ、キー名だけ残してください。",
    },
    {
      pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["'`][^"'`]{6,}["'`]/i,
      category: "password",
      risk: "high",
      label: "秘密値の直接代入があります",
      recommendation: "実値を削除し、スクリプトプロパティのキー名だけ残してください。",
    },
    {
      pattern: /https:\/\/hooks\.(?:slack|discord)\.com\/services\/[A-Za-z0-9/_-]+/i,
      category: "webhook",
      risk: "high",
      label: "Webhook URLが含まれています",
      recommendation: "Webhookを再発行し、監査ファイルから削除してください。",
    },
    {
      pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
      category: "email",
      risk: "medium",
      label: "メールアドレスが含まれています",
      recommendation: "実スタッフ・顧客のアドレスならダミー値へ置換してください。",
    },
    {
      pattern: /(?:\+81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}/,
      category: "phone",
      risk: "medium",
      label: "電話番号らしき値があります",
      recommendation: "実在する番号ならダミー値へ置換してください。",
    },
    {
      pattern: /PropertiesService\.[\s\S]*?setPropert(?:y|ies)\s*\([^)]*["'`][^"'`]{8,}["'`]/,
      category: "script_property_value",
      risk: "high",
      label: "スクリプトプロパティへ実値を書いています",
      recommendation: "監査用ファイルではキー名のみ残し、値は含めないでください。",
    },
  ];

  for (const item of patterns) {
    const match = item.pattern.exec(line);
    if (!match) continue;
    output.push({
      id: `${filename}:${lineNumber}:${item.category}`,
      filename,
      line: lineNumber,
      risk: item.risk,
      category: item.category,
      label: item.label,
      evidenceMasked: mask(match[0]),
      recommendation: item.recommendation,
    });
  }
}

function mask(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

function redactAssignment(line: string): string {
  return line.replace(
    /(\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*)(["'`])[^"'`]+\2/gi,
    "$1$2[REDACTED]$2"
  );
}
