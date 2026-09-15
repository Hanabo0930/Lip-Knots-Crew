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
  businessDataSource: "none" | "cached" | "live" | "stale";
  businessRefreshing: boolean;
  homeDisplayMs: number | null;
  businessRefreshMs: number | null;
  homeLoadedFromCache: boolean;
  deviceSessionRegistered: boolean;
  functions: Functions | null;
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error("タイムアウト")), ms); }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function overallLevel(checks: DiagnosticCheck[]): DiagnosticLevel {
  if (checks.some((check) => check.level === "fail")) return "fail";
  return checks.some((check) => check.level === "warn") ? "warn" : "pass";
}

export async function runStaffDiagnostics(input: DiagnosticInput): Promise<DiagnosticReport> {
  const startedOnline = navigator.onLine;
  const checks: DiagnosticCheck[] = [
    {
      id: "network",
      label: "インターネット接続",
      level: startedOnline ? "pass" : "fail",
      detail: startedOnline ? "接続中" : "オフラインです。通信を確認し、接続後に「もう一度診断」を押してください",
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
      level: input.businessDataStatus === "error" ? "fail" : input.businessDataStatus === "ready" && input.businessDataSource === "live" && !input.businessRefreshing ? "pass" : "warn",
      detail: input.businessDataStatus === "error" ? "取得エラー。シフト画面で更新してください"
        : input.businessDataStatus === "idle" ? "まだ取得を確認できません"
        : input.businessDataStatus === "loading" ? "読み込み中"
        : input.businessRefreshing ? "最新情報を更新中です"
        : input.businessDataSource === "cached" ? "前回データを表示中。シフト画面で更新してください"
        : input.businessDataSource === "stale" ? "更新結果を確認できません。シフト画面で更新してください"
        : input.businessDataSource === "live" ? "最新情報を取得済み" : "取得元を確認できません",
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

  let serviceWorkerReady = false;
  try {
    if ("serviceWorker" in navigator) {
      serviceWorkerReady = await withTimeout(navigator.serviceWorker.ready.then(() => true), 2_500);
    }
  } catch {
    serviceWorkerReady = false;
  }
  checks.push({
    id: "pwa",
    label: "アプリ本体",
    level: serviceWorkerReady ? "pass" : "warn",
    detail: serviceWorkerReady ? "最新版の受信準備OK" : "起動準備を確認中",
  });

  const permission = currentPushPermission();
  checks.push({
    id: "permission",
    label: "通知許可",
    level: permission === "granted" ? "pass" : permission === "denied" || permission === "unsupported" ? "fail" : "warn",
    detail: permission === "granted" ? "許可済み" : permission === "denied" ? "端末・ブラウザーの設定で通知を許可し、画面を開き直してください" : permission === "unsupported" ? "この環境は通知非対応です。ホームの「今日やること」で対応事項を確認してください" : "未設定です。受信する場合はホームの「通知を有効にする」を押してください",
  });

  let serverPushEnabled: boolean | null = null;
  if (input.functions && permission === "granted") {
    try {
      serverPushEnabled = await withTimeout(loadServerPushStatusWithRetry(input.functions), 8_000);
      checks.push({
        id: "push",
        label: "通知サービス",
        level: serverPushEnabled ? "pass" : "warn",
        detail: serverPushEnabled ? "この端末は通知ON" : "通知OFFです。受信する場合はホームの「通知を有効にする」を押してください",
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

  const latestPermission = currentPushPermission();
  if (latestPermission !== permission) {
    serverPushEnabled = null;
    const permissionIndex = checks.findIndex(check => check.id === "permission");
    checks[permissionIndex] = {
      id: "permission", label: "通知許可", level: latestPermission === "denied" || latestPermission === "unsupported" ? "fail" : "warn",
      detail: "診断中に通知許可が変更されました。端末・ブラウザーの通知設定を確認し、「もう一度診断」を押してください",
    };
    const pushIndex = checks.findIndex(check => check.id === "push");
    checks[pushIndex] = {id: "push", label: "通知サービス", level: "warn", detail: "通知設定が変わったため、通知の状態は未確認です。「もう一度診断」で確認してください"};
  }

  if (navigator.onLine !== startedOnline) {
    checks[0] = {
      id: "network", label: "インターネット接続", level: navigator.onLine ? "warn" : "fail",
      detail: navigator.onLine ? "診断中に接続が復旧しました。「もう一度診断」で最新の状態を確認してください" : "診断中にオフラインになりました。通信を確認し、接続後に「もう一度診断」を押してください",
    };
  }

  return {
    checkedAt: new Date().toISOString(),
    checks,
    summary: overallLevel(checks),
    serverPushEnabled,
  };
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const checkedAt = new Date(typeof report.checkedAt === "string" && report.checkedAt.trim() ? report.checkedAt : NaN);
  const checkedAtLabel = Number.isFinite(checkedAt.getTime()) ? checkedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + "（日本時間）" : "確認中";
  const summary = report.summary === "pass" ? "PASS" : report.summary === "warn" ? "要確認" : "エラーあり";
  const lines = report.checks.map((check) => {
    const mark = check.level === "pass" ? "OK" : check.level === "warn" ? "確認" : "NG";
    return `[${mark}] ${check.label}: ${check.detail}`;
  });
  return [
    "Lip Knots Crew かんたん診断",
    `総合結果: ${summary}`,
    `確認日時: ${checkedAtLabel}`,
    ...lines,
  ].join("\n");
}
