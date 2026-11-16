import { HttpsError } from "firebase-functions/v2/https";
import { google, type sheets_v4 } from "googleapis";
import { db } from "./firebase";
import { hashCaseList } from "./case-list-source-core";
import { createExternalExpenseBookWriter } from "./case-list-expense-book-fence";
import type { ExpensePilotBookReader } from "./case-list-expense-pilot-gateway";
import { createExpensePilotBookAccess, type ExpensePilotBook, type PilotDriveReader } from "./case-list-expense-pilot-access";
import type {
  ExternalExpenseAtomicWriter, ExternalExpenseIntent, ExternalExpenseWriteReceipt,
} from "./case-list-external-expense-completion";
import {
  expectedExternalExpenseObservationHash, externalExpenseColumns, planExternalExpenseConfirmation, readExternalCaseListExpenses,
} from "./case-list-external-transfer";

type Data = FirebaseFirestore.DocumentData;
type Receipt = ExternalExpenseWriteReceipt;
type ObservationReader = (intent: ExternalExpenseIntent) => Promise<Data>;
type BookBindings = { companyId: string; policy: ExpensePilotBook; drive: PilotDriveReader };
type ReceiptMetadata = sheets_v4.Schema$DeveloperMetadata;
type MetadataSearch = Pick<sheets_v4.Resource$Spreadsheets$Developermetadata, "search">;
type Bindings = BookBindings & {
  sheets: Pick<sheets_v4.Sheets, "spreadsheets">;
  readObservation?: ObservationReader;
  expectedSheetId?: number;
};

const KEY = "LK_CREW_EXPENSE_RECEIPT_V1_";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CASE_ID = /^LKCASE_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const COLUMN_FIELDS = new Map(Object.entries(externalExpenseColumns).map(([field, data]) => [data.index, { field, column: data.column }]));
const CALL_OPTIONS = {
  retry: false,
  retryConfig: { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] },
  timeout: 10_000,
};
const refuse = () => new Error("EXPENSE_SHEETS_WRITE_OR_RECEIPT_UNVERIFIED");

function metadataId(id: string): number {
  // Sheets requires a unique positive integer. A collision rejects the whole
  // batch, so a retried transport request cannot apply the same operation twice.
  return (Number.parseInt(hashCaseList(KEY + id).slice(0, 8), 16) & 0x7fffffff) || 1;
}

function amount(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse();
  const keys = Object.keys(value), number = (value as { numberValue?: unknown }).numberValue;
  if (!keys.length) return null;
  if (keys.length === 1 && keys[0] === "numberValue" &&
      typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 10_000_000) return number;
  throw refuse();
}

function readTarget(intent: ExternalExpenseIntent, spreadsheetId: string) {
  const { sheetId, currentRow, caseId } = intent.sheetRef ?? {};
  if (!UUID.test(intent.id) || !HASH.test(intent.beforeHash) || !HASH.test(intent.afterHash) ||
      !HASH.test(intent.acceptanceHash) || intent.sheetRef?.spreadsheetId !== spreadsheetId ||
      !Number.isSafeInteger(sheetId) || sheetId < 0 || sheetId > 0x7fffffff ||
      !Number.isSafeInteger(currentRow) || currentRow < 2 || currentRow > 0x7fffffff ||
      typeof caseId !== "string" || !CASE_ID.test(caseId) || !Array.isArray(intent.changes) ||
      !intent.changes.length || intent.changes.length > COLUMN_FIELDS.size) throw refuse();
  return { sheetId: Number(sheetId), rowIndex: Number(currentRow) - 1 };
}

function matchesObservation(intent: ExternalExpenseIntent, live: Data) {
  return live.companyId === intent.companyId && live.assignedStaffId === intent.staffId &&
    live.assignedStaffName === intent.staffName && live.dateKey === intent.dateKey &&
    live.revision === intent.jobRevision && live.expenseAcceptanceHash === intent.acceptanceHash &&
    live.caseListFinancialObservationHash === intent.beforeHash && live.sheetRef &&
    hashCaseList(live.sheetRef) === hashCaseList(intent.sheetRef);
}

function plannedCells(intent: ExternalExpenseIntent, live: Data, target: { sheetId: number; rowIndex: number }): sheets_v4.Schema$Request[] {
  const requested: Record<string, number | null> = { ...live.expenses };
  const columns = new Set<number>();
  for (const change of intent.changes) {
    const entry = COLUMN_FIELDS.get(change.index);
    if (!entry || entry.column !== change.column || columns.has(change.index) ||
        !Object.hasOwn(requested, entry.field)) throw refuse();
    columns.add(change.index);
    amount(change.expected);
    requested[entry.field] = amount(change.value);
  }
  if (hashCaseList(planExternalExpenseConfirmation(live, requested)) !== hashCaseList(intent.changes) ||
      expectedExternalExpenseObservationHash(live, requested) !== intent.afterHash) throw refuse();

  return intent.changes.map(({ index, value }) => ({
    updateCells: {
      start: { ...target, columnIndex: index },
      rows: [{ values: [Object.hasOwn(value, "numberValue") ? { userEnteredValue: value } : {}] }],
      fields: "userEnteredValue",
    },
  }));
}

async function readCurrentObservation(intent: ExternalExpenseIntent, readObservation = readExternalCaseListExpenses): Promise<Data> {
  const job = (await db.collection("jobs").doc(intent.jobId).get()).data();
  if (!job || job.companyId !== intent.companyId) throw refuse();
  return readObservation(intent.companyId, intent.jobId, job);
}

function bindBookAccess({ companyId, policy, drive }: BookBindings, mode?: "preflight") {
  const verify = createExpensePilotBookAccess(policy, drive, mode);
  return (requestCompanyId: string) => {
    if (requestCompanyId !== companyId) throw refuse();
    return verify();
  };
}

function findWritableScopeReceipts(spreadsheetId: string, metadata: MetadataSearch) {
  return async (id: string) => {
    const { data } = await metadata.search({
      spreadsheetId,
      fields: "matchedDeveloperMetadata(developerMetadata(metadataId,metadataKey,metadataValue,visibility,location))",
      requestBody: { dataFilters: [
        { developerMetadataLookup: { metadataKey: KEY + id } },
        { developerMetadataLookup: { metadataId: metadataId(id) } },
      ] },
    }, CALL_OPTIONS);
    const matches = data.matchedDeveloperMetadata ?? [];
    if (!Array.isArray(matches)) throw refuse();
    return matches.map(match => match.developerMetadata);
  };
}

function createReceiptLookup(find: (id: string) => Promise<Array<ReceiptMetadata | undefined>>,
  expectedSheetId?: number,
) {
  return {
    find,
    async readReceipt(id: string): Promise<Receipt | null> {
      if (!UUID.test(id)) return null;
      const matches = await find(id);
      if (matches.length !== 1) return null;
      const value = matches[0];
      if (value?.metadataId !== metadataId(id) || value.metadataKey !== KEY + id || value.visibility !== "PROJECT" ||
          value.location?.locationType !== "SHEET" || !Number.isSafeInteger(value.location.sheetId) || (expectedSheetId !== undefined && value.location.sheetId !== expectedSheetId) ||
          typeof value.metadataValue !== "string") return null;
      const match = /^([0-9a-f]{64}):(applied|rejected):([0-9]{1,16})$/.exec(value.metadataValue);
      if (!match) return null;
      const [, intentHash, outcome, submitted] = match;
      const recordedAtMs = Number(submitted);
      const observedAtMs = Date.now();
      if (!intentHash || !Number.isSafeInteger(recordedAtMs) || recordedAtMs > observedAtMs) return null;
      return { intentId: id, intentHash, outcome: outcome === "applied" ? "applied" : "rejected", recordedAtMs, observedAtMs };
    },
  };
}

/**
 * Private candidate for a book whose write access is limited to participants
 * in the existing book fence. It neither grants access nor sets protection.
 */
export function createSheetsExternalExpenseWriter({
  companyId, policy, drive, sheets, readObservation = readCurrentObservation, expectedSheetId,
}: Bindings): ExternalExpenseAtomicWriter {
  const { spreadsheetId } = policy;
  const verifyBook = bindBookAccess({ companyId, policy, drive });
  const lookup = createReceiptLookup(findWritableScopeReceipts(spreadsheetId, sheets.spreadsheets.developerMetadata), expectedSheetId);

  const writer = createExternalExpenseBookWriter({ companyId, spreadsheetId }, {
    async compareAndWrite(intent, beforeBatch) {
      if (intent.companyId !== companyId) throw refuse();
      const target = readTarget(intent, spreadsheetId);
      if (expectedSheetId !== undefined && target.sheetId !== expectedSheetId) throw refuse();
      const beforeVersion = await verifyBook(companyId);
      if ((await lookup.find(intent.id)).length) throw refuse();
      const live = await readObservation(intent);
      if (live.companyId !== companyId || live.sheetRef?.spreadsheetId !== spreadsheetId ||
          live.sheetRef.caseId !== intent.sheetRef.caseId || !Number.isSafeInteger(live.expenseReadStartedAt) ||
          live.expenseReadStartedAt < intent.createdAtMs || live.expenseReadStartedAt > Date.now()) throw refuse();
      const matches = matchesObservation(intent, live);
      const cells = matches ? plannedCells(intent, live, target) : [];
      if (await verifyBook(companyId) !== beforeVersion) throw refuse();
      if (beforeBatch) {
        try {
          const assertDispatchAllowed = await beforeBatch();
          // Authority checks can wait on other services. Recheck access and version after that wait.
          if (await verifyBook(companyId) !== beforeVersion) return "not_issued";
          assertDispatchAllowed();
        } catch {
          return "not_issued";
        }
      }
      const submitted = Date.now();
      const apply = matches && submitted <= intent.expiresAtMs && submitted >= intent.createdAtMs;
      const receipt: sheets_v4.Schema$Request = {
        createDeveloperMetadata: { developerMetadata: {
          metadataId: metadataId(intent.id), metadataKey: KEY + intent.id,
          metadataValue: [hashCaseList(intent), apply ? "applied" : "rejected", submitted].join(":"),
          visibility: "PROJECT", location: { sheetId: target.sheetId },
        } },
      };
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId, requestBody: { requests: [...(apply ? cells : []), receipt] },
      }, CALL_OPTIONS);
    },

    readReceipt: lookup.readReceipt,
  });
  return {
    ...writer,
    async assertWriteAccess(requestCompanyId) {
      return verifyBook(requestCompanyId);
    },
  };
}

type PilotOwnerToken = Readonly<{ oauthClientId: string; accessToken: string }>;
const METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const PREFLIGHT_SCOPES = [METADATA_SCOPE, "https://www.googleapis.com/auth/spreadsheets.readonly"];
const EXERCISE_SCOPES = [METADATA_SCOPE, "https://www.googleapis.com/auth/spreadsheets"];
const OAUTH_CLIENT_ID = /^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/;
const invalidCredential = () => new HttpsError("failed-precondition", "試験用の認証情報を確認できません。");

function bindPilotOwnerToken({ oauthClientId, accessToken }: PilotOwnerToken, expectedScopes: readonly string[]) {
  if (typeof oauthClientId !== "string" || !OAUTH_CLIENT_ID.test(oauthClientId) ||
      typeof accessToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(accessToken)) throw invalidCredential();

  async function connect() {
    const auth = new google.auth.OAuth2({ forceRefreshOnFailure: false });
    // Some supported SDK versions treat a zero constructor option as absent.
    auth.eagerRefreshThresholdMillis = 0;
    let info;
    try {
      info = await auth.getTokenInfo(accessToken);
    } catch {
      throw invalidCredential();
    }
    if (!Array.isArray(info?.scopes) || info.aud !== oauthClientId ||
        (info.azp !== undefined && info.azp !== oauthClientId)) throw invalidCredential();
    const scopes = new Set(info.scopes);
    const expiresAt = info.expiry_date;
    if (scopes.size !== expectedScopes.length || expectedScopes.some(scope => !scopes.has(scope)) ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw invalidCredential();
    // A credential that cannot refresh also prevents the SDK from replaying a failed write.
    auth.setCredentials({ access_token: accessToken, expiry_date: expiresAt });
    return { auth, expiresAt };
  }

  let connection: ReturnType<typeof connect> | undefined;
  return async () => {
    connection ??= connect().catch(error => {
      connection = undefined;
      throw error;
    });
    const bound = await connection;
    if (Date.now() >= bound.expiresAt) throw invalidCredential();
    return bound;
  };
}

/** Both Drive metadata and Sheets use the verified owner token for this run. */
export function connectSheetsExpensePilot(
  companyId: string, policy: ExpensePilotBook, expectedSheetId: number, token: PilotOwnerToken,
): ExternalExpenseAtomicWriter {
  const owner = bindPilotOwnerToken(token, EXERCISE_SCOPES);
  let writer: ReturnType<typeof connect> | undefined;
  function connect(auth: InstanceType<typeof google.auth.OAuth2>) {
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    const readObservation: typeof readExternalCaseListExpenses = async (requestedCompany, jobId, job) => {
      if (requestedCompany !== companyId) throw refuse();
      const observation = await readExternalCaseListExpenses(companyId, jobId, job, request => {
        if (request.spreadsheetId !== policy.spreadsheetId) throw refuse();
        return sheets.spreadsheets.get(request, CALL_OPTIONS);
      });
      if (observation.sheetRef?.spreadsheetId !== policy.spreadsheetId ||
          observation.sheetRef.sheetId !== expectedSheetId) throw refuse();
      return observation;
    };
    return {
      ...createSheetsExternalExpenseWriter({ companyId, policy, drive, sheets, expectedSheetId,
        readObservation: intent => readCurrentObservation(intent, readObservation),
      }),
      readObservation,
    };
  }

  async function activeWriter() {
    const { auth } = await owner();
    return writer ??= connect(auth);
  }

  return {
    async assertWriteAccess(company) { return (await activeWriter()).assertWriteAccess!(company); },
    async readObservation(company, jobId, job) { return (await activeWriter()).readObservation(company, jobId, job); },
    async compareAndWrite(intent, beforeBatch) { return (await activeWriter()).compareAndWrite(intent, beforeBatch); },
    async readReceipt(id) { return (await activeWriter()).readReceipt(id); },
    async stageReservation(tx, intent) { return (await activeWriter()).stageReservation!(tx, intent); },
    async recordUnissuedExpiry(intent) { return (await activeWriter()).recordUnissuedExpiry!(intent); },
    async stageVerifiedReceipt(tx, intent, receipt) { return (await activeWriter()).stageVerifiedReceipt!(tx, intent, receipt); },
  };
}

const PREFLIGHT_METADATA_FIELDS = "spreadsheetId,sheets(properties(sheetId),developerMetadata(metadataId,metadataKey,metadataValue,visibility,location))";
/** Pin a short-lived access token to the scopes Google reports for that exact
 * token. Neither this connection nor its SDK client can refresh the token.
 */
export function connectSheetsExpensePilotPreflight(
  companyId: string, policy: ExpensePilotBook, sheetId: number, token: PilotOwnerToken,
): ExpensePilotBookReader {
  const { spreadsheetId } = policy;
  const owner = bindPilotOwnerToken(token, PREFLIGHT_SCOPES);
  let connection: ReturnType<typeof connect> | undefined;

  function connect({ auth, expiresAt }: Awaited<ReturnType<typeof owner>>) {
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    const get = (request: sheets_v4.Params$Resource$Spreadsheets$Get) => {
      if (request.spreadsheetId !== spreadsheetId || Date.now() >= expiresAt) throw invalidCredential();
      return sheets.spreadsheets.get(request, CALL_OPTIONS);
    };

    // Metadata search requires write-capable OAuth scopes. Use a field-masked
    // spreadsheet GET and keep only same-ID or same-key sheet metadata.
    const receiptLookup = createReceiptLookup(async id => {
      const { data } = await get({ spreadsheetId, fields: PREFLIGHT_METADATA_FIELDS });
      if (data.spreadsheetId !== spreadsheetId || data.sheets?.filter(sheet => sheet.properties?.sheetId === sheetId).length !== 1) throw refuse();
      return data.sheets.flatMap(sheet => (sheet.developerMetadata ?? [])
        .filter(value => value.metadataId === metadataId(id) || value.metadataKey === KEY + id));
    }, sheetId);

    return { expiresAt, get, receiptLookup, verifyBook: bindBookAccess({ companyId, policy, drive }, "preflight") };
  }

  async function verifiedConnection() {
    const bound = await owner();
    return connection ??= connect(bound);
  }

  return {
    async assertWriteAccess(requestCompanyId) {
      if (requestCompanyId !== companyId) throw refuse();
      return (await verifiedConnection()).verifyBook(requestCompanyId);
    },
    async readReceipt(id) {
      return (await verifiedConnection()).receiptLookup.readReceipt(id);
    },
    async readObservation(requestCompanyId, jobId, job) {
      if (requestCompanyId !== companyId) throw refuse();
      const { get } = await verifiedConnection();
      return readExternalCaseListExpenses(companyId, jobId, job, get);
    },
  };
}
