import { createHash, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { createReadOnlySheetsClient } from "./sheet-reader";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { importedCaseListCancellationSourceAck } from "./sheet-write-core";
import { assertProductionOperational } from "./system-safety";
import { verifyCaseListTransferCapability } from "./case-list-transfer-capability";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import { observeCaseListManualOrigin, sameManualObservation, sourceHasManualName, manualObservationCanBePending, manualPendingAssignmentFields } from "./case-list-manual-origin-core";
import { CASE_LIST_SOURCE, configuredCaseListSource, assertExecutive, assertCaseListJobBinding, inspectCaseList, confirmedCaseListCandidate, hashCaseList, canonical, caseListMonthlyContentHash, publicCaseListSource, type Cell, type CaseListConfirmation, type CaseListSource } from "./case-list-source-core";

type Tx = FirebaseFirestore.Transaction;
type LiveSnapshot = { spreadsheetId: string; rows: Cell[][]; ledgerRows: Cell[][]; inspected: ReturnType<typeof inspectCaseList>; observedAt: string };
export function requireCaseListExecutive(token: Record<string, unknown>): void {
  try { assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? ""); }
  catch { throw new HttpsError("permission-denied", "案件リストの有効化・募集確認は、登録済みの社長アカウントで行ってください。"); }
}
async function readVerifiedMonthIdColumns(spreadsheetId: string): Promise<Record<string, string>> {
  const client = await createReadOnlySheetsClient();
  const metadata = (await client.spreadsheets.get({ spreadsheetId, fields: "spreadsheetId,properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" })).data;
  const targets = [{ title: "2026.11", sheetId: 1773116117, width: 55, column: "BC" }, { title: "2026.12", sheetId: 434431224, width: 56, column: "BD" }];
  if (metadata.spreadsheetId !== spreadsheetId || metadata.properties?.timeZone !== "Asia/Tokyo" || targets.some(target => {
    const found = metadata.sheets?.filter(sheet => sheet.properties?.title === target.title) ?? [];
    return found.length !== 1 || found[0]?.properties?.sheetId !== target.sheetId || found[0]?.properties?.gridProperties?.columnCount !== target.width;
  })) throw new HttpsError("failed-precondition", "11月・12月の月別シート構造を確認できません。");
  const data = (await client.spreadsheets.get({ spreadsheetId, ranges: targets.map(target => `'${target.title}'!A1:${target.column}1`), includeGridData: true,
    fields: "spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData.values(userEnteredValue,effectiveValue)))" })).data;
  if (data.spreadsheetId !== spreadsheetId) throw new HttpsError("failed-precondition", "月別の原本が一致しません。");
  for (const target of targets) {
    const sheet = data.sheets?.find(sheet => sheet.properties?.sheetId === target.sheetId), headers: string[] = Array(target.width).fill("");
    for (const grid of sheet?.data ?? []) {
      if ((grid.startRow ?? 0) !== 0 || (grid.rowData?.length ?? 0) > 1) throw new HttpsError("failed-precondition", "月別の見出し範囲を確認できません。");
      for (const [index, cell] of (grid.rowData?.[0]?.values ?? []).entries()) {
        const column = (grid.startColumn ?? 0) + index;
        if (column < 0 || column >= target.width) throw new HttpsError("failed-precondition", "月別の見出し列数が変わりました。");
        headers[column] = cell.userEnteredValue?.stringValue ?? cell.effectiveValue?.stringValue ?? "";
      }
    }
    if (!sheet || headers[target.width - 1] !== "連絡_固定案件ID" || headers.filter(value => value === "連絡_固定案件ID").length !== 1 || target.width === 56 && headers[54] !== "") throw new HttpsError("failed-precondition", "月別の固定案件ID列を確認できません。");
  }
  return Object.fromEntries(targets.map(target => [target.title, target.column]));
}
function mergedMonthIdColumns(current: unknown, verified: Record<string, string>): Record<string, string> {
  if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new HttpsError("failed-precondition", "既存の固定案件ID列設定を確認できません。");
  const previous = (current ?? {}) as Record<string, unknown>;
  if (Object.entries(previous).some(([name, column]) => !name.trim() || typeof column !== "string" || !/^[A-Z]{1,3}$/.test(column)) || Object.entries(verified).some(([name, column]) => previous[name] !== undefined && previous[name] !== column)) throw new HttpsError("failed-precondition", "既存設定と実際の固定案件ID列が競合しています。設定を保持して停止しました。");
  return { ...previous, ...verified } as Record<string, string>;
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
    fields: "spreadsheetId,properties.timeZone,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData.values(userEnteredValue,effectiveValue)))" });
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
  if (enable || enableAssignments) {
    requireCaseListExecutive(token);
    if (mode !== "commit" || token.companyId !== companyId || (token.uid ?? token.sub) !== actorUid) {
      throw new HttpsError("permission-denied", "有効化する会社・実行者・操作を確認できません。");
    }
  }
  if (mode === "commit") await assertProductionOperational(companyId);
  const sourceReadStartedAtMs = Date.now();
  const snapshot = await readLiveCaseList(companyId, undefined, mode === "preview" || enable);
  const verifiedColumns = enable || enableAssignments ? await readVerifiedMonthIdColumns(snapshot.spreadsheetId) : null;
  const preview = { source: "case-list", mode, observedAt: snapshot.observedAt, digest: snapshot.inspected.digest,
    counts: { total: snapshot.inspected.jobs.length, held: snapshot.inspected.jobs.filter(job => job.holdReasons.length).length, existingMonthlyLinks: snapshot.inspected.jobs.filter(job => job.ledgerLinked).length },
    rows: snapshot.inspected.jobs.map(job => ({ caseId: job.caseId, jobId: createJobIdFromPersistedCaseId(companyId, job.caseId), ...job.fields, sourceRevision: job.source.sourceRevision, holdReasons: job.holdReasons, reviewIssues: job.reviewIssues, ownerReviewRequired: job.ownerReviewRequired })) };
  if (mode === "preview") return { ...preview, writes: 0, publications: 0 };
  // An occupied Source C is observed privately, never converted into an
  // application or a native-write queue. Reuse the worker's stable-ID resolver.
  const manualRows = snapshot.rows.slice(1).filter(sourceHasManualName);
  const manualProfiles = new Map<string, Record<string, unknown>>();
  let resolveManualStaff: (name: string) => { staffId: string; identityVerified: true } | null = () => null;
  if (manualRows.length) {
    const directory = await db.collection("staffProfiles").where("companyId", "==", companyId).limit(2001).get();
    if (directory.size > 2000) throw new HttpsError("failed-precondition", "スタッフ照合の対象が多いため手入力の観測を停止しました。");
    const profiles = directory.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    for (const profile of profiles) manualProfiles.set(profile.id, profile.data);
    const { buildCaseListStaffResolver } = require("./case-list-monthly-worker") as { buildCaseListStaffResolver(profiles: Array<{ id: string; data: Record<string, unknown> }>): typeof resolveManualStaff };
    try { resolveManualStaff = buildCaseListStaffResolver(profiles); }
    catch { throw new HttpsError("failed-precondition", "既存スタッフ名簿を一意に照合できないため手入力の観測を停止しました。"); }
  }
  const leaseRef = db.collection("caseListSyncLocks").doc(companyId), tokenId = randomUUID();
  await db.runTransaction(async tx => {
    const lease = (await tx.get(leaseRef)).data();
    const configRef = db.collection("sheetImportConfigs").doc(companyId), currentConfig = (await tx.get(configRef)).data();
    const mappingRef = db.collection(`companies/${companyId}/sheetMappings`).doc("shift"), mapping = verifiedColumns ? (await tx.get(mappingRef)).data() : undefined;
    if (!currentConfig || currentConfig.companyId !== companyId || currentConfig.spreadsheetId !== snapshot.spreadsheetId) throw new HttpsError("aborted", "連携設定が読取後に変わりました。");
    const enforceOperational = (process.env.APP_ENVIRONMENT ?? "development") === "production";
    const operationalControl = enforceOperational ? (await tx.get(db.collection("productionControls").doc(companyId))).data() : null;
    if (enforceOperational && (operationalControl?.productionEnabled !== true || operationalControl?.emergencyLock !== false)) throw new HttpsError("failed-precondition", "全体の運用設定により有効化・取込を停止しました。");
    if (enableAssignments && currentConfig.caseListEnabled !== true && !enable) throw new HttpsError("failed-precondition", "案件リストの下書き連携を先に有効化してください。");
    const importColumns = verifiedColumns ? mergedMonthIdColumns(currentConfig.caseIdColumnsBySheet, verifiedColumns) : null;
    const mappingColumns = verifiedColumns && mapping ? mergedMonthIdColumns(mapping.caseIdColumnsBySheet, verifiedColumns) : null;
    if (verifiedColumns && mapping && mapping.spreadsheetId !== snapshot.spreadsheetId) throw new HttpsError("failed-precondition", "安全書込の原本設定が一致しません。");
    if (lease?.activeUntil instanceof Timestamp && lease.activeUntil.toMillis() > Date.now()) throw new HttpsError("aborted", "別の案件リスト取込が処理中です。");
    tx.set(leaseRef, { tokenId, activeUntil: Timestamp.fromMillis(Date.now() + 120000), actorUid });
    if (verifiedColumns) tx.set(configRef, { caseIdColumnsBySheet: importColumns, caseListMonthColumnsVerifiedBy: actorUid, caseListMonthColumnsVerifiedAt: Timestamp.now() }, { merge: true });
    if (mappingColumns) tx.set(mappingRef, { caseIdColumnsBySheet: mappingColumns }, { merge: true });
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
        const manualRef = db.collection("caseListManualObservations").doc(jobId), priorManual = (await tx.get(manualRef)).data();
        const rawRow = snapshot.rows.find(row => row[60]?.userEnteredValue?.stringValue === entry.caseId);
        if (!rawRow) throw new HttpsError("aborted", "手入力の観測対象が変わりました。");
        const manualObservation = observeCaseListManualOrigin({ companyId, jobId, entry, row: rawRow,
          resolveStaff: resolveManualStaff, staffProfiles: manualProfiles, existingJob: old });
        // Private observations cannot overwrite a future selected/active receipt.
        // The transfer driver remains held until that distinct contract exists.
        if (priorManual && (priorManual.companyId !== companyId || priorManual.jobId !== jobId || priorManual.caseId !== entry.caseId || priorManual.schema !== "LK_CASE_LIST_MANUAL_OBSERVATION_V1")) throw new HttpsError("failed-precondition", "手入力の既存観測と案件の対応を確認できません。記録を保持して停止しました。");
        if (priorManual?.selected === true && (!old || old.companyId !== companyId || old.assignedStaffId !== priorManual.staffId || old.assignmentSheetWrite?.queueId !== priorManual.queueId)) throw new HttpsError("failed-precondition", "選択済み手入力案件の履歴を保持して取込を停止しました。");
        const nativeCancellationPending = old?.cancellationSheetWrite?.sourceAckPending === true && Object.hasOwn(old.cancellationSheetWrite, "caseListCancellation");
        // Keep the native cancel's original private observation until its own
        // full-writable before/after-image reconciliation settles the queue.
        let manualPatch: Record<string, unknown> | null = priorManual?.selected === true || nativeCancellationPending ? null : manualObservation && !sameManualObservation(priorManual, manualObservation)
          ? { ...manualObservation, observedBy: actorUid, observedAt: Timestamp.now() }
          : !manualObservation && priorManual && priorManual.state !== "cleared"
            ? { ...priorManual, state: "cleared", source: publicCaseListSource(entry.source), selected: false,
              clientNameUpConfirmed: false, clearedBy: actorUid, clearedAt: Timestamp.now() } : null;
        const canCreateManualPending = Boolean(manualObservation && manualObservationCanBePending(manualObservation, rawRow) &&
          (!old || !old.assignedStaffId && !old.assignedStaffName && old.applicationUnconfirmed !== true && old.assignmentUnresolved !== true && old.status !== "cancelled" && old.cancelled !== true));
        const manualDayRef = canCreateManualPending ? db.collection("staffDayLocks").doc(`${companyId}_${manualObservation!.staffId}_${manualObservation!.dateKey}`) : null;
        const manualDay = manualDayRef ? (await tx.get(manualDayRef)).data() : null;
        if (canCreateManualPending && manualObservation) {
          const currentStaff = (await tx.get(db.collection("staffProfiles").doc(String(manualObservation.staffId)))).data(), observedStaff = manualProfiles.get(String(manualObservation.staffId));
          if (!currentStaff || !observedStaff || currentStaff.companyId !== companyId || currentStaff.active !== true || currentStaff.displayName !== manualObservation.canonicalStaffName ||
            canonical({ companyId: currentStaff.companyId, active: currentStaff.active, displayName: currentStaff.displayName, aliases: currentStaff.aliases ?? [] }) !== canonical({ companyId: observedStaff.companyId, active: observedStaff.active, displayName: observedStaff.displayName, aliases: observedStaff.aliases ?? [] })) throw new HttpsError("failed-precondition", "手入力のスタッフ照合中に名簿が変わりました。再読込してください。");
        }
        if (manualDay && (manualDay.companyId !== companyId || manualDay.staffId !== manualObservation!.staffId || manualDay.dateKey !== manualObservation!.dateKey)) throw new HttpsError("failed-precondition", "手入力の勤務日ロックの対応を確認できません。");
        const createManualPending = canCreateManualPending && manualDay?.active !== true;
        if (canCreateManualPending && !createManualPending && manualObservation) {
          const next = { ...manualObservation, holdReasons: [...manualObservation.holdReasons as string[], "MANUAL_STAFF_DAY_ALREADY_ASSIGNED"].sort() };
          delete (next as Record<string, unknown>).observationHash;
          manualPatch = { ...next, observationHash: hashCaseList(next), observedBy: actorUid, observedAt: Timestamp.now() };
        }
        if (!createManualPending && old?.caseListSource?.sourceRevision === entry.source.sourceRevision && old.sourceMissing !== true && !old.caseListSource?.spreadsheetId && !old.source?.spreadsheetId) {
          if (manualPatch) tx.set(manualRef, manualPatch);
          return;
        }
        let sourceCancellationConfirmed = false, cancellationReviewRequired = false;
        let cancellationDayRef: FirebaseFirestore.DocumentReference | null = null;
        if (old?.cancellationSheetWrite?.sourceAckPending === true && old.caseListManualPending && typeof old.assignedStaffId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(old.assignedStaffId) && typeof old.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(old.dateKey)) {
          const saved = old.cancellationSheetWrite;
          if (typeof saved.queueId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(saved.queueId)) throw new HttpsError("failed-precondition", "取消依頼の識別子を確認できません。");
          cancellationDayRef = db.collection("staffDayLocks").doc(`${companyId}_${old.assignedStaffId}_${old.dateKey}`);
          const [queueSnap, lockSnap] = await Promise.all([tx.get(db.collection("sheetSyncQueue").doc(saved.queueId)), tx.get(cancellationDayRef)]);
          try {
            sourceCancellationConfirmed = importedCaseListCancellationSourceAck(old, { schema: "LK_CASE_LIST_CANCEL_SOURCE_READ_V1", companyId, jobId, caseId: entry.caseId,
              dateKey: String(entry.fields.dateKey ?? ""), workDate: String(entry.fields.workDate ?? ""), source: publicCaseListSource(entry.source), rowCells: rawRow,
              queue: { ...queueSnap.data(), id: queueSnap.id }, dayLock: lockSnap.data() }, sourceReadStartedAtMs, hashCaseList);
          } catch { cancellationReviewRequired = true; }
        }
        const preserveAssignment = Boolean(old && (old.assignedStaffId || old.assignedStaffName || old.applicationUnconfirmed === true || old.assignmentUnresolved === true || old.status === "assigned" || old.status === "cancelled" || old.cancelled === true));
        const pendingQueueId = old?.applicationUnconfirmed === true && old.assignmentSheetWrite?.operation === "case_list.assign" && typeof old.assignmentSheetWrite?.queueId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(old.assignmentSheetWrite.queueId) ? old.assignmentSheetWrite.queueId : null;
        let ownPendingProjection = false;
        if (old && pendingQueueId && old.caseListSource?.rowRevision !== entry.source.rowRevision) {
          const operationId = createHash("sha256").update(companyId + "|" + pendingQueueId, "utf8").digest("hex");
          const [intentDocument, startedDocument] = await Promise.all([
            tx.get(db.collection(`caseListMonthlyOperations/${operationId}/events`).doc("SOURCE_INTENT")),
            tx.get(db.collection(`caseListMonthlyOperations/${operationId}/events`).doc("SOURCE_WRITE_STARTED")),
          ]);
          const intentRecord = intentDocument.data(), startedRecord = startedDocument.data(), intent = intentRecord?.payload, started = startedRecord?.payload;
          const actualRow = snapshot.rows.find(row => row[60]?.userEnteredValue?.stringValue === entry.caseId);
          ownPendingProjection = Boolean(intent && started && actualRow && intentRecord?.companyId === companyId && intentRecord.queueId === pendingQueueId && startedRecord?.companyId === companyId && startedRecord.queueId === pendingQueueId &&
            intentRecord.payloadHash === hashCaseList(intent) && startedRecord.payloadHash === hashCaseList(started) &&
            intent.stage === "SOURCE_INTENT" && intent.operationId === pendingQueueId && intent.caseId === entry.caseId && intent.spreadsheetId === entry.source.spreadsheetId &&
            started.stage === "SOURCE_WRITE_STARTED" && started.operationId === pendingQueueId && started.caseId === entry.caseId && started.spreadsheetId === entry.source.spreadsheetId && started.intentHash === intent.intentHash &&
            intent.assignment?.authority === "CREW_QUEUE" && intent.assignment?.schema === "LK_CASE_LIST_ASSIGN_V1" && intent.assignment?.companyId === companyId && intent.assignment?.jobId === jobId && intent.assignment?.queueId === pendingQueueId &&
            intent.assignment?.staffId === old.assignedStaffId && intent.assignment?.staffName === old.assignedStaffName && intent.preCatalog?.sourceRevision === old.caseListSource.sourceRevision && intent.preCatalog?.rowRevision === old.caseListSource.rowRevision && intent.preCatalog?.ledgerRevision === old.caseListSource.ledgerRevision &&
            entry.source.ledgerRevision === old.caseListSource.ledgerRevision && Array.isArray(intent.expectedSourceAfter) && intent.expectedSourceAfter.length === 65 &&
            intent.expectedSourceAfter[2]?.userEnteredValue?.stringValue === old.assignedStaffName && hashCaseList(actualRow.map(cell => cell.userEnteredValue ?? {})) === hashCaseList(intent.expectedSourceAfter.map((cell: Cell) => cell.userEnteredValue ?? {})));
        }
        const assignedSourceChanged = preserveAssignment && old?.caseListSource?.rowRevision !== entry.source.rowRevision && !ownPendingProjection;
        const pendingLedgerChanged = Boolean(pendingQueueId && old?.caseListSource?.ledgerRevision !== entry.source.ledgerRevision);
        const keepNativeConfirmation = preserveAssignment && !assignedSourceChanged && old?.applicationUnconfirmed === false && old.assignmentUnresolved !== true && old.assignmentSheetWrite?.nativeAck?.status === "MONTHLY_READBACK_VERIFIED";
        const keepCancellationPreimage = old?.cancellationSheetWrite?.sourceAckPending === true && !sourceCancellationConfirmed;
        const revision = old ? Number(old.revision) + (ownPendingProjection || keepCancellationPreimage ? 0 : 1) : 1;
        if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpsError("failed-precondition", "既存案件の確認版を確認できません。");
        const publicSource = pendingQueueId || keepCancellationPreimage ? { version: 1, sheetId: CASE_LIST_SOURCE.sheetId, caseId: entry.caseId,
          sourceRevision: old!.caseListSource.sourceRevision, rowRevision: old!.caseListSource.rowRevision, ledgerRevision: old!.caseListSource.ledgerRevision,
          bindingHash: publicCaseListSource(entry.source).bindingHash } : publicCaseListSource(entry.source);
        const update = { ...(preserveAssignment ? {} : entry.fields), companyId, caseId: entry.caseId, caseListSource: publicSource,
          source: { type: "case_list", bindingHash: publicSource.bindingHash, sheetId: CASE_LIST_SOURCE.sheetId },
          status: preserveAssignment ? old!.status : "draft", sourceReady: keepNativeConfirmation && old!.sourceReady === true, publishable: false, recruitmentStopped: true,
          caseListHoldReasons: entry.holdReasons, ...(!preserveAssignment ? { caseListPublication: FieldValue.delete() } : {}), sourceMissing: false,
          ...(assignedSourceChanged || pendingLedgerChanged ? { assignmentUnresolved: true, applicationUnconfirmed: true, caseListAssignmentReviewRequired: true } : {}),
          ...(ownPendingProjection ? { caseListPendingSourceWriteObserved: true } : {}),
          revision, updatedAt: Timestamp.now(), ...(!old ? { createdAt: Timestamp.now(), basePay: null, assignedStaffId: null, assignedStaffName: "", applicationUnconfirmed: false } : {}) };
        if (sourceCancellationConfirmed && cancellationDayRef && old) {
          const sourceAckProof = { readStartedAtMs: sourceReadStartedAtMs, confirmedAtMs: Date.now(), runId: tokenId,
            originalRevision: old.revision, originalIdentity: old.cancellationSheetWrite.identity, staffId: old.assignedStaffId, dateKey: old.dateKey };
          Object.assign(update, { rawStaffName: "", cancellationSheetWrite: { ...old.cancellationSheetWrite, sourceAckPending: false, sourceAckProof }, caseListCancellationReviewRequired: false });
          // Only legacy captures reach this value-only ACK guard. Settle the
          // exact queue already read and matched above; no native proof is made.
          tx.set(db.collection("sheetSyncQueue").doc(old.cancellationSheetWrite.queueId), { status: "completed", retryAt: null, writeVerificationRequired: false,
            sourceCancellationVerifiedBy: "source-import", completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
          tx.set(cancellationDayRef, { active: false, releasedAt: Timestamp.now(), releaseReason: "sheet.import.assignment_changed", jobId }, { merge: true });
          tx.set(db.collection("auditLogs").doc(), { companyId, jobId, action: "job.cancel.source.confirm", queueId: old.cancellationSheetWrite.queueId,
            staffId: old.assignedStaffId, dateKey: old.dateKey, confirmation: sourceAckProof, createdAt: Timestamp.now() });
        } else if (cancellationReviewRequired) Object.assign(update, { caseListCancellationReviewRequired: true });
        if (createManualPending && manualObservation && manualDayRef) {
          Object.assign(update, manualPendingAssignmentFields(manualObservation));
          tx.set(manualDayRef, { companyId, jobId, staffId: manualObservation.staffId, dateKey: manualObservation.dateKey, active: true, updatedAt: Timestamp.now() });
        }
        if (manualPatch) tx.set(manualRef, manualPatch);
        if (old) tx.update(jobRef, update);
        else tx.set(jobRef, update);
        if (preserveAssignment) tx.set(db.collection("caseListSourceObservations").doc(jobId), { companyId, jobId, sourceRevision: entry.source.sourceRevision,
          rowRevision: entry.source.rowRevision, ledgerRevision: entry.source.ledgerRevision, pendingQueueId, ownPendingProjection, observedAt: Timestamp.now() });
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
        const manualRef = db.collection("caseListManualObservations").doc(ref.id), priorManual = (await tx.get(manualRef)).data();
        if (priorManual && priorManual.selected !== true && priorManual.state !== "source_missing") tx.set(manualRef, {
          ...priorManual, state: "source_missing", selected: false, clientNameUpConfirmed: false,
          missingObservedBy: actorUid, missingObservedAt: Timestamp.now(),
        });
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
  const config = (await tx.get(db.collection("sheetImportConfigs").doc(companyId))).data();
  if (config?.companyId !== companyId || config.caseListEnabled !== true || config.caseListAssignmentsEnabled !== true) throw new HttpsError("failed-precondition", "案件リストの応募・月別連携はまだ有効化されていません。");
  if (typeof job.caseId !== "string") throw new HttpsError("failed-precondition", "募集枠の固定IDを確認できません。");
  const monthlySnapshot = await readCaseListMonthlySnapshot(companyId, job.caseId);
  const observedAt = new Date().toISOString();
  const snapshot = { spreadsheetId: monthlySnapshot.spreadsheetId, rows: monthlySnapshot.rawRows, ledgerRows: monthlySnapshot.rawLedgerRows, observedAt,
    inspected: inspectCaseList(monthlySnapshot.rawRows, monthlySnapshot.rawLedgerRows, observedAt, monthlySnapshot.spreadsheetId) };
  const entry = snapshot.inspected.jobs.find(entry => entry.caseId === job.caseId);
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
  // A newly reviewed region must be the exact current Source BE value. It
  // cannot fill a blank Source cell or substitute for a Source publication.
  const confirmedRegion = (approval as CaseListConfirmation & { confirmedRegion?: string }).confirmedRegion;
  if (confirmedRegion !== undefined && (typeof confirmedRegion !== "string" || !confirmedRegion.trim() || confirmedRegion !== confirmedRegion.trim() || confirmedRegion.length > 100 || confirmedRegion !== candidate.region)) throw new HttpsError("failed-precondition", "原本の地域と社長が確認した地域が一致しません。原本を確認してください。");
  await verifyCaseListTransferCapability(companyId, entry.source, monthlySnapshot);
  const jobFields = { dateKey: candidate.date, workDate: candidate.date, clientName: candidate.client, storeName: candidate.store, makerName: candidate.manufacturer, menuName: candidate.menu, entryTime: candidate.arrival, workTime: candidate.execution, region: candidate.region };
  if (!confirmation && (Object.entries(jobFields).some(([key, value]) => job[key] !== value) || job.basePay !== (candidate.payOffer as { dailyWageJPY: number }).dailyWageJPY || !job.publicPayOffer || hashCaseList(job.publicPayOffer) !== hashCaseList(candidate.payOffer))) throw new HttpsError("failed-precondition", "アプリと案件リストの募集条件が一致しません。取り込み直して確認してください。");
  const row = snapshot.rows.find(row => row[60]?.userEnteredValue?.stringValue === entry.caseId);
  if (!row) throw new HttpsError("failed-precondition", "元の募集枠を確認できません。");
  // This mail bridge has no owner-reviewed public-note/extra-allowance
  // contract yet. A populated or formula-based BM must not silently vanish.
  const recruitmentNotice = row[64];
  const publicNoteUnreviewed = [recruitmentNotice?.userEnteredValue, recruitmentNotice?.effectiveValue].some(raw => raw && Object.entries(raw).some(([key, value]) => key !== "stringValue" || typeof value !== "string" || value.trim() !== ""));
  const typeHints = [row[10], row[13], row[16]].flatMap(cell => [cell?.userEnteredValue?.stringValue, cell?.effectiveValue?.stringValue]).filter(value => typeof value === "string").join(" ");
  // AF:AJ were public extra-pay labels in the existing mail adapter. Until
  // those per-label conditions have an owner-reviewed receipt, do not omit
  // a nonzero/unknown amount or derive a new public amount from private pay.
  const noExtraPay = (raw?: Record<string, unknown>) => !raw || Object.entries(raw).every(([key, value]) => key === "numberValue" && value === 0 || key === "stringValue" && typeof value === "string" && ["", "0"].includes(value.trim()));
  const additionalPayUnreviewed = row.slice(31, 36).some(cell => Object.hasOwn(cell.userEnteredValue ?? {}, "formulaValue")
    ? cell.effectiveValue?.numberValue !== 0
    : !noExtraPay(cell.userEnteredValue) || !noExtraPay(cell.effectiveValue));
  const recruitmentTextHoldReasons = [
    ...(publicNoteUnreviewed ? ["PUBLIC_RECRUITMENT_NOTES_UNREVIEWED"] : []),
    ...(additionalPayUnreviewed ? ["PUBLIC_ADDITIONAL_PAY_UNREVIEWED"] : []),
    ...(/研修|OJT|ラウンダー|出口調査|グレイス|グレース/i.test(typeHints) ? ["UNSUPPORTED_RECRUITMENT_TYPE"] : []),
  ];
  return { candidate, jobFields, source: entry.source, preMonthlyContentHash: caseListMonthlyContentHash(row), approval: { ...approval, actorUid: owner }, observedAt: snapshot.observedAt, recruitmentTextHoldReasons };
}
