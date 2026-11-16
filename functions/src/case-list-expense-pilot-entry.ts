import { HttpsError } from "firebase-functions/v2/https";
import type { ExpensePilotBook } from "./case-list-expense-pilot-access";
import { connectExpensePilotGateway, type ExpensePilotPolicy } from "./case-list-expense-pilot-gateway";
import { createExpensePilotHttpHandler } from "./case-list-expense-pilot-http";
import { connectSheetsExpensePilot, connectSheetsExpensePilotPreflight } from "./case-list-expense-sheets-writer";

type Credentials = { mode: "preflight" | "exercise"; oauthClientId: string; accessToken: string };

/** Assembles a handler for an expressly approved isolated target. No export in the default Functions index. */
export function createApprovedExpensePilotEntry(policy: ExpensePilotPolicy, book: ExpensePilotBook, credentials: Credentials) {
  if (!policy.enabled || policy.spreadsheetId !== book.spreadsheetId || policy.mode !== credentials.mode) {
    throw new HttpsError("failed-precondition", "承認された試験用ブックと接続方針が一致しません。");
  }
  const gateway = connectExpensePilotGateway(policy, () => credentials.mode === "preflight"
    ? connectSheetsExpensePilotPreflight(policy.companyId, book, policy.sheetId, credentials)
    : connectSheetsExpensePilot(policy.companyId, book, policy.sheetId, credentials)
  );
  return createExpensePilotHttpHandler(gateway);
}
