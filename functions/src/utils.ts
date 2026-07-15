import { createHash, randomUUID } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

export function requireAuth(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  return request.auth;
}

export function requireAdmin(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  const session = requireAuth(request);
  if (session.token.role !== "admin") {
    throw new HttpsError("permission-denied", "管理者権限が必要です。");
  }
  return session;
}

export function companyFromClaims(token: Record<string, unknown>): string {
  const value = token.companyId;
  if (typeof value !== "string" || !value) {
    throw new HttpsError("failed-precondition", "会社情報が設定されていません。");
  }
  return value;
}

export function staffFromClaims(token: Record<string, unknown>): string {
  const value = token.staffId;
  if (typeof value !== "string" || !value) {
    throw new HttpsError("failed-precondition", "スタッフ情報が設定されていません。");
  }
  return value;
}

export function requestId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function dateKeyFromIso(isoDate: string): string {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(isoDate);
  if (!match) {
    throw new HttpsError("invalid-argument", "日付形式が不正です。");
  }
  return isoDate;
}
