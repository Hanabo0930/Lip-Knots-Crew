import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { google, sheets_v4 } from "googleapis";
import { z } from "zod";
import { db } from "./firebase";
import { getProductionOperationalState } from "./system-safety";
import {
  buildInsertPlan,
  cloneConditionalRuleForRow,
  columnToIndex,
  conditionalRulesCoveringTemplate,
  formulaVerification,
  missingConditionalRulesForRows,
  monthSheetName,
  RowScanInput,
  validationVerification,
} from "./sheet-row-creation-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";

type QueueDocument = {
  companyId: string;
  groupId: string;
  jobIds: string[];
  status: string;
  attempts?: number;
  idempotencyKey?: string;
  actorUid?: string;
};

type RowCreationConfig = {
  enabled?: boolean;
  spreadsheetId: string;
  idColumn: string;
  columns: Record<string, string>;
  identityColumns: {
    workDate: string;
    clientName: string;
    storeName: string;
    workTime: string;
  };
  rowCreation?: {
    enabled?: boolean;
    headerRow?: number;
    dataStartRow?: number;
    maxRows?: number;
    rowEndColumn?: string;
    formulaColumns?: string[];
    requiredValidationColumns?: string[];
    copyFormat?: boolean;
    copyFormula?: boolean;
    copyDataValidation?: boolean;
    cloneConditionalFormatting?: boolean;
    rollbackOnVerificationFailure?: boolean;
  };
  monthCreation?: {
    enabled?: boolean;
    verifiedSpreadsheetId?: string;
  };
};

type JobRecord = FirebaseFirestore.DocumentData & { id: string };

const PreviewSchema = z.object({
  groupId: z.string().min(1).optional(),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rows: z.number().int().min(1).max(20).default(1),
}).refine((value) => Boolean(value.groupId || value.dateKey), {
  message: "groupIdまたはdateKeyが必要です。",
});

export const processSheetRowCreation = onDocumentWritten(
  "sheetRowCreateQueue/{queueId}",
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const queue = after.data() as QueueDocument;
    if (queue.status !== "pending") return;
    const state = await getProductionOperationalState(queue.companyId);
    if (!state.operational) {
      await after.ref.set({
        status: "paused_global",
        pauseReason: state.reason,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    const claimed = await claimQueue(after.ref);
    if (!claimed) return;

    try {
      await executeRowCreation(after.ref, queue);
    } catch (error) {
      await failQueue(after.ref, error);
    }
  }
);

export const retrySheetRowCreation = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async () => {
    const due = await db.collection("sheetRowCreateQueue")
      .where("status", "==", "retry_wait")
      .where("retryAt", "<=", Timestamp.now())
      .limit(50)
      .get();

    const batch = db.batch();
    due.docs.forEach((doc) => batch.set(doc.ref, {
      status: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
    if (!due.empty) await batch.commit();
  }
);

export const previewSheetRowCreation = onCall(
  { timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = PreviewSchema.parse(request.data ?? {});
    const mapping = await loadMapping(companyId);
    const dateKey = input.groupId
      ? await dateKeyFromGroup(companyId, input.groupId)
      : String(input.dateKey);
    return preflight(companyId, mapping, dateKey, input.rows, undefined, false);
  }
);

export const getPilotReadiness = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);

  const [
    featureSnap,
    mappingSnap,
    shiftConfigSnap,
    staffConfigSnap,
    recentRows,
    blockedRows,
    deadRows,
    setupDraftSnap,
    monthInterventions,
  ] = await Promise.all([
    db.collection("companyFeatureSettings").doc(companyId).get(),
    db.doc(`companies/${companyId}/sheetMappings/shift`).get(),
    db.collection("sheetImportConfigs").doc(companyId).get(),
    db.collection("staffImportConfigs").doc(companyId).get(),
    db.collection("sheetRowCreateQueue")
      .where("companyId", "==", companyId)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get(),
    db.collection("sheetRowCreateQueue")
      .where("companyId", "==", companyId)
      .where("status", "==", "blocked")
      .limit(100)
      .get(),
    db.collection("sheetRowCreateQueue")
      .where("companyId", "==", companyId)
      .where("status", "==", "dead_letter")
      .limit(100)
      .get(),
    db.collection("setupWizardDrafts").doc(companyId).get(),
    db.collection("monthSheetManualInterventions")
      .where("companyId", "==", companyId)
      .where("status", "==", "open")
      .limit(100)
      .get(),
  ]);

  const mapping = mappingSnap.data() as RowCreationConfig | undefined;
  const checks = [
    {
      key: "shift_read",
      label: "シフト表の読取同期",
      ok: shiftConfigSnap.exists && shiftConfigSnap.data()?.enabled === true,
    },
    {
      key: "staff_read",
      label: "スタッフ名簿の読取同期",
      ok: staffConfigSnap.exists && staffConfigSnap.data()?.enabled === true,
    },
    {
      key: "safe_mapping",
      label: "安全書込マッピング",
      ok: mappingSnap.exists && mapping?.enabled === true,
    },
    {
      key: "row_creation",
      label: "新規行追加",
      ok: mapping?.rowCreation?.enabled === true,
    },
    {
      key: "case_id",
      label: "案件ID列",
      ok: Boolean(mapping?.idColumn && mapping?.columns?.caseId),
    },
    {
      key: "feature_flag",
      label: "管理画面の案件追加",
      ok: featureSnap.exists &&
        featureSnap.data()?.adminJobCreationSourceReady === true,
    },
    {
      key: "setup_draft",
      label: "導入設定の下書き",
      ok: setupDraftSnap.exists && setupDraftSnap.data()?.allEnabled === false,
    },
    {
      key: "month_creation",
      label: "新月タブ作成",
      ok: mapping?.monthCreation?.enabled === true,
    },
    {
      key: "verified_copy",
      label: "検証コピー承認",
      ok: mapping?.monthCreation?.verifiedSpreadsheetId === mapping?.spreadsheetId,
    },
    {
      key: "month_feature",
      label: "新月作成の会社設定",
      ok: featureSnap.exists &&
        featureSnap.data()?.monthSheetCreationReady === true,
    },
    {
      key: "blocked_queue",
      label: "停止中の行追加キューなし",
      ok: blockedRows.empty && deadRows.empty,
    },
    {
      key: "month_intervention",
      label: "新月タブの手動確認なし",
      ok: monthInterventions.empty,
    },
  ];

  return {
    ready: checks.every((check) => check.ok),
    checks,
    blockedCount: blockedRows.size,
    deadLetterCount: deadRows.size,
    monthInterventionCount: monthInterventions.size,
    recentQueues: recentRows.docs.map((doc) => ({
      id: doc.id,
      ...serialize(doc.data()),
    })),
  };
});

async function executeRowCreation(
  queueRef: FirebaseFirestore.DocumentReference,
  queue: QueueDocument
): Promise<void> {
  const idempotencyRef = queue.idempotencyKey
    ? db.collection("sheetRowCreationIdempotency").doc(
        hash(`${queue.companyId}|${queue.idempotencyKey}`)
      )
    : null;

  if (idempotencyRef) {
    const existing = await idempotencyRef.get();
    if (
      existing.exists &&
      existing.data()?.status === "completed" &&
      existing.data()?.queueId !== queueRef.id
    ) {
      await queueRef.set({
        status: "completed",
        duplicateOf: existing.data()?.queueId ?? null,
        completedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }
  }

  const mapping = await loadMapping(queue.companyId);
  ensureRowCreationEnabled(mapping);
  const jobs = await loadJobs(queue.companyId, queue.jobIds);
  if (!jobs.length || jobs.length !== queue.jobIds.length) {
    throw new BlockedError("行追加対象の案件が揃っていません。");
  }

  const alreadyReady = jobs.every((job) =>
    job.sourceReady === true &&
    Boolean(job.sheetRef?.spreadsheetId) &&
    Boolean(job.sheetRef?.currentRow)
  );
  if (alreadyReady) {
    await queueRef.set({
      status: "completed",
      alreadyCompleted: true,
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  const dates = [...new Set(jobs.map((job) => String(job.dateKey ?? job.workDate ?? "")))];
  if (dates.length !== 1 || !dates[0]) {
    throw new BlockedError("同じキュー内の実施日が一致しません。");
  }

  const lock = await acquireLock(queue.companyId, dates[0]);
  let inserted: {
    spreadsheetId: string;
    sheetId: number;
    sheetName: string;
    startRow: number;
    endRow: number;
    caseIds: string[];
  } | null = null;

  try {
    const sheets = await createSheetsClient();
    const preflightResult = await preflight(
      queue.companyId,
      mapping,
      dates[0],
      jobs.length,
      sheets
    );
    if (!preflightResult.ready) {
      throw new BlockedError(preflightResult.errors.join(" / "));
    }

    inserted = await insertRows({
      sheets,
      mapping,
      jobs,
      sheetId: preflightResult.sheetId,
      sheetName: preflightResult.sheetName,
      templateRow: preflightResult.templateRow,
      insertedRows: preflightResult.insertedRows,
    });

    const verification = await verifyInsertedRows({
      sheets,
      mapping,
      jobs,
      inserted,
      templateConditionalRules: preflightResult.templateConditionalRules,
    });

    if (!verification.ok) {
      const rollbackEnabled = mapping.rowCreation?.rollbackOnVerificationFailure !== false;
      if (rollbackEnabled) {
        const rolledBack = await rollbackInsertedRows(sheets, mapping, inserted);
        if (!rolledBack) {
          throw new ManualInterventionError(
            `検算失敗、かつ自動ロールバックを安全に実行できません: ${verification.errors.join(" / ")}`
          );
        }
        inserted = null;
      }
      throw new BlockedError(
        `新規行の検算に失敗したため元へ戻しました: ${verification.errors.join(" / ")}`
      );
    }

    const now = Timestamp.now();
    const batch = db.batch();
    jobs.forEach((job, index) => {
      const row = inserted!.startRow + index;
      const publication = publicationAfterSourceReady(job);
      batch.set(db.collection("jobs").doc(job.id), {
        sheetRef: {
          spreadsheetId: mapping.spreadsheetId,
          sheetId: inserted!.sheetId,
          sheetName: inserted!.sheetName,
          currentRow: row,
          headerRow: mapping.rowCreation?.headerRow ?? 1,
        },
        source: {
          type: "google_sheets_admin_created",
          spreadsheetId: mapping.spreadsheetId,
          sheetName: inserted!.sheetName,
          row,
          queueId: queueRef.id,
        },
        sourceReady: true,
        sourceCreationStatus: "completed",
        sourceCreationError: FieldValue.delete(),
        pendingSourceWrite: false,
        pendingSourceFields: FieldValue.delete(),
        status: publication.status,
        publishable: publication.publishable,
        recruitmentStopped: publication.recruitmentStopped,
        scheduledPublishAt: publication.scheduledPublishAt,
        publicationBlockedReason: FieldValue.delete(),
        sourceCreatedAt: now,
        updatedAt: now,
        revision: FieldValue.increment(1),
      }, { merge: true });
    });

    batch.set(db.collection("jobGroups").doc(queue.groupId), {
      sourceReady: true,
      sourceCreationStatus: "completed",
      sheetName: inserted.sheetName,
      startRow: inserted.startRow,
      endRow: inserted.endRow,
      updatedAt: now,
    }, { merge: true });

    batch.set(queueRef, {
      status: "completed",
      sheetName: inserted.sheetName,
      sheetId: inserted.sheetId,
      startRow: inserted.startRow,
      endRow: inserted.endRow,
      verification,
      completedAt: now,
      updatedAt: now,
    }, { merge: true });

    batch.set(db.collection("auditLogs").doc(), {
      companyId: queue.companyId,
      actorUid: queue.actorUid ?? null,
      action: "sheet.rows.create",
      queueId: queueRef.id,
      groupId: queue.groupId,
      jobIds: queue.jobIds,
      sheetName: inserted.sheetName,
      startRow: inserted.startRow,
      endRow: inserted.endRow,
      verification,
      requestId: requestId("audit"),
      createdAt: now,
    });

    if (idempotencyRef) {
      batch.set(idempotencyRef, {
        companyId: queue.companyId,
        queueId: queueRef.id,
        status: "completed",
        sheetName: inserted.sheetName,
        startRow: inserted.startRow,
        endRow: inserted.endRow,
        completedAt: now,
      });
    }

    await batch.commit();
  } catch (error) {
    if (inserted && !(error instanceof ManualInterventionError)) {
      try {
        const sheets = await createSheetsClient();
        const rolledBack = await rollbackInsertedRows(sheets, mapping, inserted);
        if (!rolledBack) {
          error = new ManualInterventionError(
            `処理失敗後の自動ロールバックを安全に実行できません。元エラー: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        } else {
          inserted = null;
        }
      } catch (rollbackError) {
        error = new ManualInterventionError(
          `処理失敗後のロールバックでもエラーが発生しました: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`
        );
      }
    }
    if (inserted && error instanceof ManualInterventionError) {
      await db.collection("sheetRowManualInterventions").add({
        companyId: queue.companyId,
        queueId: queueRef.id,
        inserted,
        errorMessage: error.message,
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

async function preflight(
  companyId: string,
  mapping: RowCreationConfig,
  dateKey: string,
  rows: number,
  existingClient?: sheets_v4.Sheets,
  requireEnabled = true
): Promise<{
  ready: boolean;
  errors: string[];
  warnings: string[];
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  templateRow: number;
  insertBeforeRow: number;
  insertedRows: number[];
  formulaColumns: string[];
  requiredValidationColumns: string[];
  templateConditionalRules: sheets_v4.Schema$ConditionalFormatRule[];
}> {
  if (requireEnabled) {
    ensureRowCreationEnabled(mapping);
  } else {
    ensureMappingBasics(mapping);
  }
  const sheets = existingClient ?? await createSheetsClient();
  const sheetName = monthSheetName(dateKey);
  const rowConfig = normalizedRowConfig(mapping);
  const activationWarnings: string[] = [];
  if (mapping.enabled !== true) activationWarnings.push("安全書込は現在OFFです。");
  if (mapping.rowCreation?.enabled !== true) activationWarnings.push("新規行追加は現在OFFです。");

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: mapping.spreadsheetId,
    fields: "sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),conditionalFormats)",
  });

  const target = (spreadsheet.data.sheets ?? []).find(
    (sheet) => sheet.properties?.title === sheetName
  );
  if (target?.properties?.sheetId === null || target?.properties?.sheetId === undefined) {
    return {
      ready: false,
      errors: [`月別タブ「${sheetName}」がありません。自動作成はまだ行いません。`],
      warnings: activationWarnings,
      spreadsheetId: mapping.spreadsheetId,
      sheetId: 0,
      sheetName,
      templateRow: 0,
      insertBeforeRow: 0,
      insertedRows: [],
      formulaColumns: rowConfig.formulaColumns,
      requiredValidationColumns: rowConfig.requiredValidationColumns,
      templateConditionalRules: [],
    };
  }

  const scanRanges = [
    mapping.identityColumns.workDate,
    mapping.identityColumns.clientName,
    mapping.identityColumns.storeName,
    mapping.identityColumns.workTime,
  ].map((column) =>
    `'${quoteSheetName(sheetName)}'!${column}${rowConfig.dataStartRow}:${column}${rowConfig.maxRows}`
  );
  const scan = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: mapping.spreadsheetId,
    ranges: scanRanges,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const maxLength = Math.max(
    0,
    ...(scan.data.valueRanges ?? []).map((range) => range.values?.length ?? 0)
  );
  const scanRows: RowScanInput[] = Array.from({ length: maxLength }, (_, index) => ({
    rowNumber: rowConfig.dataStartRow + index,
    workDate: scan.data.valueRanges?.[0]?.values?.[index]?.[0] ?? "",
    clientName: scan.data.valueRanges?.[1]?.values?.[index]?.[0] ?? "",
    storeName: scan.data.valueRanges?.[2]?.values?.[index]?.[0] ?? "",
    workTime: scan.data.valueRanges?.[3]?.values?.[index]?.[0] ?? "",
  }));

  let plan;
  try {
    plan = buildInsertPlan(scanRows, rows, {
      dataStartRow: rowConfig.dataStartRow,
      maxRows: rowConfig.maxRows,
      rowEndColumn: rowConfig.rowEndColumn,
      templateFormulaColumns: rowConfig.formulaColumns,
      requiredValidationColumns: rowConfig.requiredValidationColumns,
    });
  } catch (error) {
    return {
      ready: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: activationWarnings,
      spreadsheetId: mapping.spreadsheetId,
      sheetId: target.properties.sheetId,
      sheetName,
      templateRow: 0,
      insertBeforeRow: 0,
      insertedRows: [],
      formulaColumns: rowConfig.formulaColumns,
      requiredValidationColumns: rowConfig.requiredValidationColumns,
      templateConditionalRules: [],
    };
  }

  const formulaRanges = rowConfig.formulaColumns.map((column) =>
    `'${quoteSheetName(sheetName)}'!${column}${plan.templateRow}`
  );
  const formulaResponse = formulaRanges.length
    ? await sheets.spreadsheets.values.batchGet({
        spreadsheetId: mapping.spreadsheetId,
        ranges: formulaRanges,
        valueRenderOption: "FORMULA",
      })
    : null;
  const formulaValues: Record<string, unknown> = {};
  rowConfig.formulaColumns.forEach((column, index) => {
    formulaValues[column] =
      formulaResponse?.data.valueRanges?.[index]?.values?.[0]?.[0] ?? "";
  });

  const formulaErrors = formulaVerification(
    formulaValues,
    rowConfig.formulaColumns
  );

  const validationState = await readValidationState(
    sheets,
    mapping.spreadsheetId,
    target.properties.sheetId,
    sheetName,
    plan.templateRow,
    rowConfig.requiredValidationColumns
  );
  const validationErrors = validationVerification(
    validationState,
    rowConfig.requiredValidationColumns
  );

  const allRules = (target.conditionalFormats ?? []) as sheets_v4.Schema$ConditionalFormatRule[];
  const templateConditionalRules = conditionalRulesCoveringTemplate(
    allRules,
    plan.templateRow
  ) as sheets_v4.Schema$ConditionalFormatRule[];

  const warnings: string[] = [...activationWarnings];
  if (!templateConditionalRules.length) {
    warnings.push("雛形行を対象とする条件付き書式は見つかりませんでした。");
  }

  const rowCount = target.properties.gridProperties?.rowCount ?? 0;
  if (plan.insertBeforeRow + rows - 1 > rowCount) {
    warnings.push("シート末尾に近いため、Google Sheetsが行数を自動拡張します。");
  }

  return {
    ready: formulaErrors.length === 0 && validationErrors.length === 0,
    errors: [...formulaErrors, ...validationErrors],
    warnings,
    spreadsheetId: mapping.spreadsheetId,
    sheetId: target.properties.sheetId,
    sheetName,
    templateRow: plan.templateRow,
    insertBeforeRow: plan.insertBeforeRow,
    insertedRows: plan.insertedRows,
    formulaColumns: rowConfig.formulaColumns,
    requiredValidationColumns: rowConfig.requiredValidationColumns,
    templateConditionalRules,
  };
}

async function insertRows(input: {
  sheets: sheets_v4.Sheets;
  mapping: RowCreationConfig;
  jobs: JobRecord[];
  sheetId: number;
  sheetName: string;
  templateRow: number;
  insertedRows: number[];
}): Promise<{
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  startRow: number;
  endRow: number;
  caseIds: string[];
}> {
  const rowConfig = normalizedRowConfig(input.mapping);
  const startRow = input.insertedRows[0]!;
  const endRow = input.insertedRows[input.insertedRows.length - 1]!;
  const endColumnIndex = columnToIndex(rowConfig.rowEndColumn) + 1;

  const requests: sheets_v4.Schema$Request[] = [{
    insertDimension: {
      range: {
        sheetId: input.sheetId,
        dimension: "ROWS",
        startIndex: startRow - 1,
        endIndex: endRow,
      },
      inheritFromBefore: true,
    },
  }];

  input.insertedRows.forEach((rowNumber, index) => {
    if (rowConfig.copyFormula) {
      requests.push(copyRequest(
        input.sheetId,
        input.templateRow,
        rowNumber,
        endColumnIndex,
        "PASTE_FORMULA"
      ));
    }
    if (rowConfig.copyFormat) {
      requests.push(copyRequest(
        input.sheetId,
        input.templateRow,
        rowNumber,
        endColumnIndex,
        "PASTE_FORMAT"
      ));
    }
    if (rowConfig.copyDataValidation) {
      requests.push(copyRequest(
        input.sheetId,
        input.templateRow,
        rowNumber,
        endColumnIndex,
        "PASTE_DATA_VALIDATION"
      ));
    }

    const job = input.jobs[index]!;
    const values = inputValuesForJob(job, input.mapping);
    Object.entries(values).forEach(([key, value]) => {
      const column = input.mapping.columns[key];
      if (!column) throw new BlockedError(`${key}の列マッピングがありません。`);
      requests.push({
        updateCells: {
          range: {
            sheetId: input.sheetId,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: columnToIndex(column),
            endColumnIndex: columnToIndex(column) + 1,
          },
          rows: [{
            values: [{ userEnteredValue: toExtendedValue(value) }],
          }],
          fields: "userEnteredValue",
        },
      });
    });
  });

  await input.sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.mapping.spreadsheetId,
    requestBody: { requests },
  });

  return {
    spreadsheetId: input.mapping.spreadsheetId,
    sheetId: input.sheetId,
    sheetName: input.sheetName,
    startRow,
    endRow,
    caseIds: input.jobs.map((job) => String(job.caseId ?? "")),
  };
}

async function verifyInsertedRows(input: {
  sheets: sheets_v4.Sheets;
  mapping: RowCreationConfig;
  jobs: JobRecord[];
  inserted: {
    spreadsheetId: string;
    sheetId: number;
    sheetName: string;
    startRow: number;
    endRow: number;
    caseIds: string[];
  };
  templateConditionalRules: sheets_v4.Schema$ConditionalFormatRule[];
}): Promise<{
  ok: boolean;
  errors: string[];
  conditionalRulesAdded: number;
}> {
  const rowConfig = normalizedRowConfig(input.mapping);
  const errors: string[] = [];
  const ranges: string[] = [];

  input.jobs.forEach((_job, index) => {
    const row = input.inserted.startRow + index;
    ranges.push(
      `'${quoteSheetName(input.inserted.sheetName)}'!${input.mapping.idColumn}${row}`
    );
    rowConfig.formulaColumns.forEach((column) =>
      ranges.push(`'${quoteSheetName(input.inserted.sheetName)}'!${column}${row}`)
    );
  });

  const values = await input.sheets.spreadsheets.values.batchGet({
    spreadsheetId: input.mapping.spreadsheetId,
    ranges,
    valueRenderOption: "FORMULA",
  });

  let cursor = 0;
  input.jobs.forEach((job) => {
    const caseId = values.data.valueRanges?.[cursor++]?.values?.[0]?.[0] ?? "";
    if (String(caseId) !== String(job.caseId ?? "")) {
      errors.push(`${job.caseId}: 案件IDの書込後検証に失敗しました。`);
    }
    const formulaValues: Record<string, unknown> = {};
    rowConfig.formulaColumns.forEach((column) => {
      formulaValues[column] =
        values.data.valueRanges?.[cursor++]?.values?.[0]?.[0] ?? "";
    });
    errors.push(...formulaVerification(
      formulaValues,
      rowConfig.formulaColumns
    ).map((error) => `${job.caseId}: ${error}`));
  });

  const validationColumns = rowConfig.requiredValidationColumns;
  for (let index = 0; index < input.jobs.length; index++) {
    const row = input.inserted.startRow + index;
    const state = await readValidationState(
      input.sheets,
      input.mapping.spreadsheetId,
      input.inserted.sheetId,
      input.inserted.sheetName,
      row,
      validationColumns
    );
    errors.push(...validationVerification(state, validationColumns)
      .map((error) => `${input.jobs[index]!.caseId}: ${error}`));
  }

  let conditionalRulesAdded = 0;
  if (
    errors.length === 0 &&
    rowConfig.cloneConditionalFormatting &&
    input.templateConditionalRules.length
  ) {
    const afterSheet = await input.sheets.spreadsheets.get({
      spreadsheetId: input.mapping.spreadsheetId,
      ranges: [input.inserted.sheetName],
      fields: "sheets(properties(sheetId),conditionalFormats)",
    });
    const afterRules = (
      afterSheet.data.sheets?.[0]?.conditionalFormats ?? []
    ) as sheets_v4.Schema$ConditionalFormatRule[];
    const missing = missingConditionalRulesForRows(
      input.templateConditionalRules,
      afterRules,
      Array.from(
        { length: input.jobs.length },
        (_, index) => input.inserted.startRow + index
      )
    );

    if (missing.length) {
      const endColumnIndex = columnToIndex(rowConfig.rowEndColumn) + 1;
      const requests = missing.map(({ templateRule, rowNumber }) => ({
        addConditionalFormatRule: {
          rule: cloneConditionalRuleForRow(
            templateRule,
            input.inserted.sheetId,
            rowNumber,
            endColumnIndex
          ) as sheets_v4.Schema$ConditionalFormatRule,
          index: 0,
        },
      }));
      await input.sheets.spreadsheets.batchUpdate({
        spreadsheetId: input.mapping.spreadsheetId,
        requestBody: { requests },
      });
      conditionalRulesAdded = requests.length;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    conditionalRulesAdded,
  };
}

async function rollbackInsertedRows(
  sheets: sheets_v4.Sheets,
  mapping: RowCreationConfig,
  inserted: {
    spreadsheetId: string;
    sheetId: number;
    sheetName: string;
    startRow: number;
    endRow: number;
    caseIds: string[];
  }
): Promise<boolean> {
  const idRange =
    `'${quoteSheetName(inserted.sheetName)}'!${mapping.idColumn}${inserted.startRow}:` +
    `${mapping.idColumn}${inserted.endRow}`;
  const ids = await sheets.spreadsheets.values.get({
    spreadsheetId: mapping.spreadsheetId,
    range: idRange,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const current = (ids.data.values ?? []).map((row) => String(row[0] ?? ""));
  const expected = inserted.caseIds.map(String);
  if (JSON.stringify(current) !== JSON.stringify(expected)) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: mapping.spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: inserted.sheetId,
            dimension: "ROWS",
            startIndex: inserted.startRow - 1,
            endIndex: inserted.endRow,
          },
        },
      }],
    },
  });
  return true;
}

async function readValidationState(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  sheetName: string,
  rowNumber: number,
  columns: string[]
): Promise<Record<string, boolean>> {
  if (!columns.length) return {};
  const ranges = columns.map((column) =>
    `'${quoteSheetName(sheetName)}'!${column}${rowNumber}`
  );
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges,
    includeGridData: true,
    fields: "sheets(data(startRow,startColumn,rowData(values(dataValidation))))",
  });

  const state: Record<string, boolean> = {};
  columns.forEach((column) => state[column] = false);

  for (const data of response.data.sheets?.[0]?.data ?? []) {
    const startColumn = data.startColumn ?? 0;
    const startRow = data.startRow ?? 0;
    if (startRow !== rowNumber - 1) continue;
    const values = data.rowData?.[0]?.values ?? [];
    values.forEach((cell, offset) => {
      const columnIndex = startColumn + offset;
      const matched = columns.find((column) => columnToIndex(column) === columnIndex);
      if (matched) state[matched] = Boolean(cell.dataValidation);
    });
  }
  return state;
}

async function loadMapping(companyId: string): Promise<RowCreationConfig> {
  const snap = await db.doc(`companies/${companyId}/sheetMappings/shift`).get();
  if (!snap.exists) throw new HttpsError(
    "failed-precondition",
    "安全書込マッピングがありません。"
  );
  return snap.data() as RowCreationConfig;
}

function ensureMappingBasics(mapping: RowCreationConfig): void {
  if (!mapping.spreadsheetId || !mapping.idColumn) {
    throw new BlockedError("スプレッドシートIDまたは案件ID列がありません。");
  }
  if (!mapping.identityColumns?.workDate || !mapping.identityColumns?.clientName ||
      !mapping.identityColumns?.storeName || !mapping.identityColumns?.workTime) {
    throw new BlockedError("行判定用の列設定が不足しています。");
  }
}

function ensureRowCreationEnabled(mapping: RowCreationConfig): void {
  ensureMappingBasics(mapping);
  if (mapping.enabled !== true) {
    throw new BlockedError("安全書込が有効ではありません。");
  }
  if (mapping.rowCreation?.enabled !== true) {
    throw new BlockedError("新規行追加はまだ有効化されていません。");
  }
}

function normalizedRowConfig(mapping: RowCreationConfig) {
  return {
    headerRow: mapping.rowCreation?.headerRow ?? 1,
    dataStartRow: mapping.rowCreation?.dataStartRow ?? 2,
    maxRows: mapping.rowCreation?.maxRows ?? 10000,
    rowEndColumn: mapping.rowCreation?.rowEndColumn ?? mapping.idColumn,
    formulaColumns: mapping.rowCreation?.formulaColumns ?? ["AA", "AJ", "AR", "BB"],
    requiredValidationColumns:
      mapping.rowCreation?.requiredValidationColumns ?? [],
    copyFormat: mapping.rowCreation?.copyFormat !== false,
    copyFormula: mapping.rowCreation?.copyFormula !== false,
    copyDataValidation: mapping.rowCreation?.copyDataValidation !== false,
    cloneConditionalFormatting:
      mapping.rowCreation?.cloneConditionalFormatting !== false,
  };
}

async function loadJobs(
  companyId: string,
  jobIds: string[]
): Promise<JobRecord[]> {
  const snapshots = await db.getAll(
    ...jobIds.map((id) => db.collection("jobs").doc(id))
  );
  const byId = new Map<string, JobRecord>();
  snapshots.forEach((snap) => {
    if (snap.exists && snap.data()?.companyId === companyId) {
      byId.set(snap.id, { id: snap.id, ...(snap.data() ?? {}) });
    }
  });
  return jobIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
}

async function dateKeyFromGroup(
  companyId: string,
  groupId: string
): Promise<string> {
  const group = await db.collection("jobGroups").doc(groupId).get();
  if (!group.exists || group.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件グループが見つかりません。");
  }
  const jobIds = Array.isArray(group.data()?.jobIds)
    ? group.data()?.jobIds.map(String)
    : [];
  const jobs = await loadJobs(companyId, jobIds);
  const dates = [...new Set(
    jobs.map((job) => String(job.dateKey ?? job.workDate ?? "")).filter(Boolean)
  )];
  if (dates.length !== 1) {
    throw new HttpsError(
      "failed-precondition",
      "案件グループの実施日が一致しません。"
    );
  }
  return dates[0]!;
}

function inputValuesForJob(
  job: JobRecord,
  mapping: RowCreationConfig
): Record<string, unknown> {
  return {
    workDate: job.dateKey ?? job.workDate ?? "",
    staffName: "",
    clientName: job.clientName ?? "",
    storeName: job.storeName ?? "",
    makerName: job.makerName ?? "",
    menuName: job.menuName ?? "",
    entryTime: job.entryTime ?? "",
    workTime: job.workTime ?? "",
    subcontractorName: job.subcontractorName ?? "",
    staffBasePay: job.basePay ?? "",
    caseId: job.caseId ?? "",
  };
}

function publicationAfterSourceReady(job: JobRecord): {
  status: string;
  publishable: boolean;
  recruitmentStopped: boolean;
  scheduledPublishAt: Timestamp | null | FirebaseFirestore.FieldValue;
} {
  const mode = String(job.requestedPublicationMode ?? "draft");
  if (mode === "immediate") {
    return {
      status: "open",
      publishable: true,
      recruitmentStopped: false,
      scheduledPublishAt: FieldValue.delete(),
    };
  }
  if (mode === "scheduled") {
    const requested = job.requestedPublishAt;
    const timestamp = requested instanceof Timestamp
      ? requested
      : requested ? Timestamp.fromDate(new Date(String(requested))) : null;
    if (timestamp && timestamp.toMillis() <= Date.now()) {
      return {
        status: "open",
        publishable: true,
        recruitmentStopped: false,
        scheduledPublishAt: FieldValue.delete(),
      };
    }
    return {
      status: "scheduled",
      publishable: false,
      recruitmentStopped: true,
      scheduledPublishAt: timestamp,
    };
  }
  return {
    status: "draft",
    publishable: false,
    recruitmentStopped: true,
    scheduledPublishAt: FieldValue.delete(),
  };
}

function copyRequest(
  sheetId: number,
  sourceRow: number,
  destinationRow: number,
  endColumnIndex: number,
  pasteType: string
): sheets_v4.Schema$Request {
  return {
    copyPaste: {
      source: {
        sheetId,
        startRowIndex: sourceRow - 1,
        endRowIndex: sourceRow,
        startColumnIndex: 0,
        endColumnIndex,
      },
      destination: {
        sheetId,
        startRowIndex: destinationRow - 1,
        endRowIndex: destinationRow,
        startColumnIndex: 0,
        endColumnIndex,
      },
      pasteType,
      pasteOrientation: "NORMAL",
    },
  };
}

function toExtendedValue(value: unknown): sheets_v4.Schema$ExtendedValue {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { numberValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  const text = String(value ?? "");
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) {
    const utc = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    const sheetsEpoch = Date.UTC(1899, 11, 30);
    return { numberValue: (utc - sheetsEpoch) / 86400000 };
  }
  return { stringValue: text };
}

async function createSheetsClient(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function claimQueue(
  ref: FirebaseFirestore.DocumentReference
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.status !== "pending") return false;
    tx.set(ref, {
      status: "processing",
      attempts: FieldValue.increment(1),
      processingStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
}

async function failQueue(
  ref: FirebaseFirestore.DocumentReference,
  error: unknown
): Promise<void> {
  const snap = await ref.get();
  const attempts = Number(snap.data()?.attempts ?? 1);
  const blocked =
    error instanceof BlockedError ||
    error instanceof ManualInterventionError;
  const retryable = !blocked && attempts < 5;

  const status = error instanceof ManualInterventionError
    ? "manual_intervention"
    : blocked
      ? "blocked"
      : retryable
        ? "retry_wait"
        : "dead_letter";
  const errorMessage = error instanceof Error ? error.message : String(error);
  const batch = db.batch();
  batch.set(ref, {
    status,
    errorType: error instanceof ManualInterventionError
      ? "manual_intervention"
      : blocked
        ? "blocked"
        : "system",
    errorMessage,
    retryAt: retryable
      ? Timestamp.fromMillis(Date.now() + Math.min(30, 2 ** attempts) * 60_000)
      : null,
    failedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const data = snap.data() as QueueDocument | undefined;
  for (const jobId of data?.jobIds ?? []) {
    batch.set(db.collection("jobs").doc(jobId), {
      sourceCreationStatus: status,
      sourceCreationError: errorMessage,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  if (data?.groupId) {
    batch.set(db.collection("jobGroups").doc(data.groupId), {
      sourceCreationStatus: status,
      sourceCreationError: errorMessage,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

async function acquireLock(
  companyId: string,
  dateKey: string
): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}> {
  const sheetName = monthSheetName(dateKey);
  const ref = db.collection("syncLocks").doc(
    `${companyId}_sheet_row_create_${sheetName.replace(".", "_")}`
  );
  const token = db.collection("_ids").doc().id;
  const now = Timestamp.now();
  const leaseUntil = Timestamp.fromMillis(now.toMillis() + 8 * 60 * 1000);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existingLease = snap.data()?.leaseUntil as Timestamp | undefined;
    if (existingLease && existingLease.toMillis() > now.toMillis()) {
      throw new HttpsError(
        "already-exists",
        `月別タブ「${sheetName}」への別の追加処理が実行中です。`
      );
    }
    tx.set(ref, {
      companyId,
      token,
      sheetName,
      acquiredAt: now,
      leaseUntil,
    });
  });
  return { ref, token };
}

async function releaseLock(lock: {
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lock.ref);
    if (snap.data()?.token === lock.token) tx.delete(lock.ref);
  });
}

function quoteSheetName(value: string): string {
  return value.replace(/'/g, "''");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serialize(
  data: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    value instanceof Timestamp ? value.toDate().toISOString() : value,
  ]));
}

class BlockedError extends Error {}
class ManualInterventionError extends Error {}
