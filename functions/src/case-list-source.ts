import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { createReadOnlySheetsClient } from "./sheet-reader";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { assertProductionOperational } from "./system-safety";
import { verifyCaseListTransferCapability } from "./case-list-transfer-capability";
import { CASE_LIST_SOURCE, configuredCaseListSource, assertExecutive, assertCaseListJobBinding, inspectCaseList, confirmedCaseListCandidate, hashCaseList, caseListMonthlyContentHash, type Cell, type CaseListConfirmation, type CaseListSource } from "./case-list-source-core";

type Tx = FirebaseFirestore.Transaction;
type LiveSnapshot = { spreadsheetId: string; rows: Cell[][]; ledgerRows: Cell[][]; inspected: ReturnType<typeof inspectCaseList>; observedAt: string };
export function requireCaseListExecutive(token: Record<string, unknown>): void {
  try { assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? ""); }
  catch { throw new HttpsError("permission-denied", "案件リストの有効化・募集確認は、登録済みの社長アカウントで行ってください。"); }
}
export async function readLiveCaseList(companyId: string, tx?: Tx, allowDisabled = false): Promise<LiveSnapshot> {
  const configRef = db.collection("sheetImportConfigs").doc(companyId);
  const config = (tx ? await tx.get(configRef) : await configRef.get()).data();
  if (!config || config.companyId !== companyId || (!allowDisabled && config.caseListEnabled !== true)) throw new HttpsError("failed-precondition", "案件リストの連携設定が無効、または原本が一致しません。");
  let bookId: string;
  try { bookId = configuredCaseListSource(config.spreadsheetId).spreadsheetId; } catch { throw new HttpsError("failed-precondition", "サーバーの原本設定を確認できません。"); }
  const sheets = await createReadOnlySheetsClient();
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: bookId, fields: "spreadsheetId,properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" });
  const source = metadata.data.sheets?.find(sheet => sheet.properties?.sheetId === CASE_LIST_SOURCE.sheetId)?.properties;
  const ledger = metadata.data.sheets?.find(sheet => sheet.properties?.sheetId === 2026102605)?.properties;
  const sourceRowCount = source?.gridProperties?.rowCount;
  const ledgerRowCount = ledger?.gridProperties?.rowCount;
  if (metadata.data.spreadsheetId !== bookId || metadata.data.properties?.timeZone !== "Asia/Tokyo" || source?.title !== "案件リスト" || source.gridProperties?.columnCount !== 65 || ledger?.title !== "案件_実績台帳" || ledger.gridProperties?.columnCount !== 25 || typeof sourceRowCount !== "number" || !Number.isInteger(sourceRowCount) || sourceRowCount < 1 || sourceRowCount > 5001 || typeof ledgerRowCount !== "number" || !Number.isInteger(ledgerRowCount) || ledgerRowCount < 1 || ledgerRowCount > 5005) throw new HttpsError("failed-precondition", "案件リストまたは実績台帳の構造を確認できません。");
  const result = await sheets.spreadsheets.get({ spreadsheetId: bookId,
    ranges: [`'案件リスト'!A1:BM${sourceRowCount}`, `'案件_実績台帳'!A1:Y${ledgerRowCount}`], includeGridData: true,
    fields: "spreadsheetId,properties.timeZone,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData.values(userEnteredValue,effectiveValue,userEnteredFormat,dataValidation,note,textFormatRuns,chipRuns)))" });
  const dense = (sheetId: number, width: number, count: number): Cell[][] => {
    const sheet = result.data.sheets?.find(sheet => sheet.properties?.sheetId === sheetId);
    if (!sheet || sheet.properties?.gridProperties?.rowCount !== count || sheet.properties?.gridProperties?.columnCount !== width || result.data.spreadsheetId !== bookId || result.data.properties?.timeZone !== "Asia/Tokyo") throw new HttpsError("aborted", "読取中にシフト表の構造が変わりました。再度確認してください。");
    const rows: Cell[][] = Array.from({ length: count }, () => Array.from({ length: width }, () => ({})));
    for (const grid of sheet.data ?? []) for (const [r, sourceRow] of (grid.rowData ?? []).entries()) {
      const row = (grid.startRow ?? 0) + r;
      const targetRow = rows[row];
      for (const [c, cell] of (sourceRow.values ?? []).entries()) {
        const column = (grid.startColumn ?? 0) + c;
        if (!targetRow || column < 0 || column >= width) throw new HttpsError("aborted", "読取範囲が変わりました。");
        targetRow[column] = cell as Cell;
      }
    }
    return rows;
  };
  const rows = dense(CASE_LIST_SOURCE.sheetId, 65, sourceRowCount);
  const ledgerRows = dense(2026102605, 25, ledgerRowCount);
  const observedAt = new Date().toISOString();
  try { return { spreadsheetId: bookId, rows, ledgerRows, inspected: inspectCaseList(rows, ledgerRows, observedAt, bookId), observedAt }; }
  catch { throw new HttpsError("failed-precondition", "案件リストの固定ID・見出し・実績台帳を確認できません。元の値を保持して停止しました。"); }
}
export async function executeCaseListImport(companyId: string, mode: "preview" | "commit", actorUid: string, token: Record<string, unknown>, enable = false, enableAssignments = false) {
  if (enable || enableAssignments) requireCaseListExecutive(token);
  // Draft implementation checkpoint: remove only when the dedicated queue
  // writer and its exact native ACK have passed integration review.
  if (enableAssignments) throw new HttpsError("failed-precondition", "月別シフトへの連携は検証中です。下書き取込は利用できます。");
  if (mode === "commit") await assertProductionOperational(companyId);
  const snapshot = await readLiveCaseList(companyId, undefined, mode === "preview" || enable);
  const preview = { source: "case-list", mode, observedAt: snapshot.observedAt, digest: snapshot.inspected.digest,
    counts: { total: snapshot.inspected.jobs.length, held: snapshot.inspected.jobs.filter(job => job.holdReasons.length).length, existingMonthlyLinks: snapshot.inspected.jobs.filter(job => job.ledgerLinked).length },
    rows: snapshot.inspected.jobs.map(job => ({ caseId: job.caseId, jobId: createJobIdFromPersistedCaseId(companyId, job.caseId), ...job.fields, sourceRevision: job.source.sourceRevision, holdReasons: job.holdReasons, reviewIssues: job.reviewIssues, ownerReviewRequired: job.ownerReviewRequired })) };
  if (mode === "preview") return { ...preview, writes: 0, publications: 0 };
  const leaseRef = db.collection("caseListSyncLocks").doc(companyId), tokenId = randomUUID();
  await db.runTransaction(async tx => {
    const lease = (await tx.get(leaseRef)).data();
    if (lease?.activeUntil instanceof Timestamp && lease.activeUntil.toMillis() > Date.now()) throw new HttpsError("aborted", "別の案件リスト取込が処理中です。");
    tx.set(leaseRef, { tokenId, activeUntil: Timestamp.fromMillis(Date.now() + 120000), actorUid });
    if (enable) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListEnabled: true, caseListEnabledBy: actorUid, caseListEnabledAt: Timestamp.now() }, { merge: true });
    if (enableAssignments) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListAssignmentsEnabled: true, caseListAssignmentsEnabledBy: actorUid, caseListAssignmentsEnabledAt: Timestamp.now() }, { merge: true });
  });
  let writes = 0, heldLinked = 0;
  try {
    const catalogRef = db.collection("caseListCatalogs").doc(companyId);
    const previousIds = ((await catalogRef.get()).data()?.caseIds ?? []) as string[];
    for (const entry of snapshot.inspected.jobs) {
      const jobId = createJobIdFromPersistedCaseId(companyId, entry.caseId), jobRef = db.collection("jobs").doc(jobId);
      await db.runTransaction(async tx => {
        const [lease, current, config] = await Promise.all([tx.get(leaseRef), tx.get(jobRef), tx.get(db.collection("sheetImportConfigs").doc(companyId))]);
        if (lease.data()?.tokenId !== tokenId || config.data()?.caseListEnabled !== true) throw new HttpsError("aborted", "案件リスト取込の設定または処理権限が変わりました。");
        const old = current.data();
        if (old && (old.companyId !== companyId || old.caseId !== entry.caseId || !old.caseListSource)) { heldLinked++; return; }
        if (!old && entry.ledgerLinked) { heldLinked++; return; }
        if (old?.caseListSource?.sourceRevision === entry.source.sourceRevision && old.sourceMissing !== true) return;
        const preserveAssignment = Boolean(old && (old.assignedStaffId || old.assignedStaffName || old.applicationUnconfirmed === true || old.assignmentUnresolved === true || old.status === "assigned"));
        const revision = old ? Number(old.revision) + 1 : 1;
        if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpsError("failed-precondition", "既存案件の確認版を確認できません。");
        tx.set(jobRef, { ...(preserveAssignment ? {} : entry.fields), companyId, caseId: entry.caseId, caseListSource: entry.source,
          source: { type: "case_list", spreadsheetId: entry.source.spreadsheetId, sheetId: CASE_LIST_SOURCE.sheetId },
          status: preserveAssignment ? old!.status : "draft", sourceReady: false, publishable: false, recruitmentStopped: true,
          caseListHoldReasons: entry.holdReasons, caseListPublication: FieldValue.delete(), sourceMissing: false,
          revision, updatedAt: Timestamp.now(), ...(!old ? { createdAt: Timestamp.now(), basePay: null, assignedStaffId: null, assignedStaffName: "", applicationUnconfirmed: false } : {}) }, { merge: true });
        tx.set(leaseRef, { activeUntil: Timestamp.fromMillis(Date.now() + 120000) }, { merge: true });
        writes++;
      });
    }
    const currentIds = new Set(snapshot.inspected.jobs.map(job => job.caseId));
    for (const caseId of previousIds) if (!currentIds.has(caseId)) {
      const ref = db.collection("jobs").doc(createJobIdFromPersistedCaseId(companyId, caseId));
      await db.runTransaction(async tx => {
        const [current, lease, config] = await Promise.all([tx.get(ref), tx.get(leaseRef), tx.get(db.collection("sheetImportConfigs").doc(companyId))]);
        if (lease.data()?.tokenId !== tokenId || config.data()?.caseListEnabled !== true) throw new HttpsError("aborted", "案件リスト取込の設定または処理権限が変わりました。");
        const job = current.data();
        if (!job || job.companyId !== companyId || !job.caseListSource) return;
        tx.update(ref, { sourceMissing: true, publishable: false, recruitmentStopped: true, caseListHoldReasons: ["SOURCE_MISSING_RETAINED"], updatedAt: Timestamp.now() });
      });
    }
    await db.runTransaction(async tx => {
      const [lease, config] = await Promise.all([tx.get(leaseRef), tx.get(db.collection("sheetImportConfigs").doc(companyId))]);
      if (lease.data()?.tokenId !== tokenId || config.data()?.caseListEnabled !== true) throw new HttpsError("aborted", "案件リスト取込の設定または処理権限が変わりました。");
      tx.set(catalogRef, { companyId, caseIds: [...currentIds], digest: snapshot.inspected.digest, observedAt: snapshot.observedAt, completedAt: Timestamp.now(), actorUid });
    });
    return { ...preview, writes, heldLinked, publications: 0 };
  } finally {
    await db.runTransaction(async tx => { if ((await tx.get(leaseRef)).data()?.tokenId === tokenId) tx.delete(leaseRef); });
  }
}
export async function readCaseListPublication(tx: Tx, companyId: string, jobId: string, job: Record<string, unknown>, expectedJobRevision: number | undefined, expectedSourceRevision: string | undefined, confirmation?: CaseListConfirmation, actorUid?: string) {
  if (!Number.isSafeInteger(expectedJobRevision) || expectedJobRevision !== job.revision || typeof expectedSourceRevision !== "string") throw new HttpsError("failed-precondition", "案件の確認版が変わりました。一覧を更新してください。");
  const snapshot = await readLiveCaseList(companyId, tx), entry = snapshot.inspected.jobs.find(entry => entry.caseId === job.caseId);
  if ((await tx.get(db.collection("sheetImportConfigs").doc(companyId))).data()?.caseListAssignmentsEnabled !== true) throw new HttpsError("failed-precondition", "案件リストの応募・月別連携はまだ有効化されていません。");
  if (!entry || entry.source.sourceRevision !== expectedSourceRevision) throw new HttpsError("failed-precondition", "案件リストまたは実績台帳が更新されました。取込後に確認してください。");
  try { assertCaseListJobBinding(companyId, jobId, job, entry.source, createJobIdFromPersistedCaseId); }
  catch { throw new HttpsError("failed-precondition", "案件と原本の対応が変わりました。"); }
  const savedDocument = (await tx.get(db.collection("caseListApprovals").doc(jobId))).data();
  const saved = savedDocument?.companyId === companyId && savedDocument.jobId === jobId
    ? savedDocument as CaseListConfirmation & { actorUid: string } : undefined;
  const approval = confirmation ?? saved, owner = actorUid ?? saved?.actorUid;
  if (!approval || !owner || approval.expectedSourceRevision !== expectedSourceRevision) throw new HttpsError("failed-precondition", "この確認版の募集条件は社長未確認です。");
  let candidate: Record<string, unknown>;
  try { candidate = confirmedCaseListCandidate(snapshot.rows, snapshot.ledgerRows, entry.caseId, approval, new Date().toISOString(), owner, snapshot.spreadsheetId); }
  catch { throw new HttpsError("failed-precondition", "募集条件・担当の照合が完了していません。原本の確認事項を解消してください。"); }
  await verifyCaseListTransferCapability(companyId, entry.source);
  const jobFields = { dateKey: candidate.date, workDate: candidate.date, clientName: candidate.client, storeName: candidate.store, makerName: candidate.manufacturer, menuName: candidate.menu, entryTime: candidate.arrival, workTime: candidate.execution, region: candidate.region };
  if (!confirmation && (Object.entries(jobFields).some(([key, value]) => job[key] !== value) || job.basePay !== (candidate.payOffer as { dailyWageJPY: number }).dailyWageJPY || !job.publicPayOffer || hashCaseList(job.publicPayOffer) !== hashCaseList(candidate.payOffer))) throw new HttpsError("failed-precondition", "アプリと案件リストの募集条件が一致しません。取り込み直して確認してください。");
  const row = snapshot.rows.find(row => row[60]?.userEnteredValue?.stringValue === entry.caseId);
  if (!row) throw new HttpsError("failed-precondition", "元の募集枠を確認できません。");
  return { candidate, jobFields, source: entry.source, preMonthlyContentHash: caseListMonthlyContentHash(row), approval: { ...approval, actorUid: owner }, observedAt: snapshot.observedAt };
}
