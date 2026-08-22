import type { Functions } from "firebase/functions";
import {
  currentPushPermission,
  loadServerPushStatusWithRetry,
} from "./push";

export type DiagnosticLevel = "pass" | "warn" | "fail";
export type DiagnosticCheck = {
  id: string;
  label: string;
  level: DiagnosticLevel;
  detail: string;
};
export type DiagnosticReport = {
  checkedAt: string;
  checks: DiagnosticCheck[];
  summary: DiagnosticLevel;
  serverPushEnabled: boolean | null;
};

type DiagnosticInput = {
  signedIn: boolean;
  companyScoped: boolean;
  businessDataStatus: "idle" | "loading" | "ready" | "error";
  homeDisplayMs: number | null;
  businessRefreshMs: number | null;
  homeLoadedFromCache: boolean;
  deviceSessionRegistered: boolean;
  functions: Functions | null;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error("タイムアウト")), ms)),
  ]);
}

function overallLevel(checks: DiagnosticCheck[]): DiagnosticLevel {
  if (checks.some((check) => check.level === "fail")) return "fail";
  return checks.some((check) => check.level === "warn") ? "warn" : "pass";
}

export async function runStaffDiagnostics(input: DiagnosticInput): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [
    {
      id: "network",
      label: "インターネット接続",
      level: navigator.onLine ? "pass" : "fail",
      detail: navigator.onLine ? "接続中" : "オフラインです",
    },
    {
      id: "auth",
      label: "ログイン",
      level: input.signedIn ? "pass" : "fail",
      detail: input.signedIn ? "ログイン済み" : "再ログインが必要です",
    },
    {
      id: "company",
      label: "所属情報",
      level: input.companyScoped ? "pass" : "fail",
      detail: input.companyScoped ? "確認済み" : "会社・スタッフ情報を確認できません",
    },
    {
      id: "business",
      label: "業務データ",
      level: input.businessDataStatus === "ready" ? "pass" : input.businessDataStatus === "error" ? "fail" : "warn",
      detail: input.businessDataStatus === "ready" ? "取得済み" : input.businessDataStatus === "error" ? "取得エラー" : "読み込み中",
    },
    {
      id: "device",
      label: "この端末",
      level: input.deviceSessionRegistered ? "pass" : "warn",
      detail: input.deviceSessionRegistered ? "利用中として登録済み" : "端末登録を確認中",
    },
  ];

  if (input.homeDisplayMs !== null) {
    checks.push({
      id: "speed",
      label: "ホーム表示速度",
      level: input.homeDisplayMs <= 3_000 ? "pass" : input.homeDisplayMs <= 8_000 ? "warn" : "fail",
      detail: `${(input.homeDisplayMs / 1_000).toFixed(1)}秒${input.homeLoadedFromCache ? "（前回データを先に表示）" : ""}`,
    });
  }

  if (input.businessRefreshMs !== null) {
    checks.push({
      id: "refresh",
      label: "最新情報の更新",
      level: input.businessRefreshMs <= 10_000 ? "pass" : input.businessRefreshMs <= 20_000 ? "warn" : "fail",
      detail: `${(input.businessRefreshMs / 1_000).toFixed(1)}秒（ホーム表示を止めずに更新）`,
    });
  }

  const serviceWorkerReady = await ("serviceWorker" in navigator
    ? withTimeout(navigator.serviceWorker.ready.then(() => true), 2_500).catch(() => false)
    : Promise.resolve(false));
  checks.push({
    id: "pwa",
    label: "アプリ本体",
    level: serviceWorkerReady ? "pass" : "warn",
    detail: serviceWorkerReady ? "最新版の受信準備OK" : "起動準備を確認中",
  });

  const permission = currentPushPermission();
  checks.push({
    id: "permission",
    label: "iPhone通知許可",
    level: permission === "granted" ? "pass" : permission === "denied" || permission === "unsupported" ? "fail" : "warn",
    detail: permission === "granted" ? "許可済み" : permission === "denied" ? "端末設定で拒否中" : permission === "unsupported" ? "非対応" : "未設定",
  });

  let serverPushEnabled: boolean | null = null;
  if (input.functions && permission === "granted") {
    try {
      serverPushEnabled = await withTimeout(loadServerPushStatusWithRetry(input.functions), 8_000);
      checks.push({
        id: "push",
        label: "通知サービス",
        level: serverPushEnabled ? "pass" : "warn",
        detail: serverPushEnabled ? "この端末は通知ON" : "通知端末の再登録が必要です",
      });
    } catch {
      checks.push({
        id: "push",
        label: "通知サービス",
        level: "fail",
        detail: "接続を確認できません",
      });
    }
  } else {
    checks.push({
      id: "push",
      label: "通知サービス",
      level: permission === "granted" ? "warn" : "fail",
      detail: permission === "granted" ? "接続準備中" : "通知許可後に確認できます",
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    checks,
    summary: overallLevel(checks),
    serverPushEnabled,
  };
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const summary = report.summary === "pass" ? "PASS" : report.summary === "warn" ? "要確認" : "エラーあり";
  const lines = report.checks.map((check) => {
    const mark = check.level === "pass" ? "OK" : check.level === "warn" ? "確認" : "NG";
    return `[${mark}] ${check.label}: ${check.detail}`;
  });
  return [
    "Lip Knots Crew かんたん診断",
    `総合結果: ${summary}`,
    `確認日時: ${new Date(report.checkedAt).toLocaleString("ja-JP")}`,
    ...lines,
  ].join("\n");
}
