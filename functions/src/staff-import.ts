import { assertProductionOperational } from "./system-safety";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { auth, db } from "./firebase";
import { emailHash, requireAdmin, companyFromClaims } from "./utils";
import {
  createReadOnlySheetsClient,
  listSpreadsheetSheets,
  readNamedSheet,
  selectNamedSheets,
} from "./sheet-reader";
import { columnLetterToIndex, mergeStaffRows, parseStaffSheet } from "./staff-parser";
import {
  MergedStaffProfile,
  StaffImportConfig,
  StaffSheetSummary,
} from "./staff-import-types";

const RequestSchema = z.object({
  sheetNames: z.array(z.string().min(1)).max(20).optional(),
});

const ColumnSchema = z.object({
  displayName: z.string().min(1),
  homePrefecture: z.string().optional(),
  nearestStation: z.string().optional(),
  birthDate: z.string().optional(),
  email: z.string().min(1),
  phone: z.string().optional(),
  manualInactive: z.string().optional(),
  rank: z.string().optional(),
  evaluationTags: z.string().optional(),
  evaluationMemo: z.string().optional(),
});

const ConfigSchema = z.object({
  companyId: z.string().min(1),
  enabled: z.boolean(),
  scheduleEnabled: z.boolean().default(false),
  spreadsheetId: z.string().min(10),
  spreadsheetLabel: z.string().optional(),
  activeSheets: z.array(z.string().min(1)).min(1),
  excludedSheets: z.array(z.string()).default(["抹消"]),
  sheetAreas: z.record(z.string(), z.string()).default({}),
  headerRow: z.number().int().positive().nullable().optional(),
  dataStartRow: z.number().int().positive().nullable().optional(),
  maxRowsPerSheet: z.number().int().min(100).max(50000).default(5000),
  readRangeEndColumn: z.string().regex(/^[A-Z]+$/).default("T"),
  maxSheetsPerRun: z.number().int().min(1).max(20).default(10),
  markMissingInactive: z.boolean().default(false),
  revokeRemovedEmailSessions: z.boolean().default(true),
  configVersion: z.string().default("0.3"),
  columns: ColumnSchema,
});

type ImportMode = "preview" | "commit";

type ImportResult = {
  runId: string | null;
  mode: ImportMode;
  companyId: string;
  sheets: StaffSheetSummary[];
  totals: {
    sheets: number;
    sourceRows: number;
    profiles: number;
    multipleEmailProfiles: number;
    profilesWithoutEmail: number;
    invalidEmails: number;
    emailConflicts: number;
    profileConflicts: number;
    activated: number;
    inactivated: number;
    emailIndexesWritten: number;
    sessionsRevoked: number;
    firestoreWrites: number;
  };
  warnings: string[];
  samples: Array<{
    staffId: string;
    displayName: string;
    emails: string[];
    areaLabels: string[];
    active: boolean;
  }>;
};

export const previewStaffImport = onCall(
  { timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = RequestSchema.parse(request.data ?? {});
    return executeStaffImport(companyId, "preview", input.sheetNames);
  }
);

export const syncStaffDirectoryReadOnly = onCall(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = RequestSchema.parse(request.data ?? {});
    return executeStaffImport(companyId, "commit", input.sheetNames);
  }
);

export const syncStaffDirectoryScheduled = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 540,
    memory: "2GiB",
    maxInstances: 1,
  },
  async () => {
    const configs = await db.collection("staffImportConfigs")
      .where("enabled", "==", true)
      .where("scheduleEnabled", "==", true)
      .limit(20)
      .get();

    for (const config of configs.docs) {
      try {
        await executeStaffImport(config.id, "commit");
      } catch (error) {
        console.error("Scheduled staff sync failed", {
          companyId: config.id,
          error,
        });
      }
    }
  }
);

export const getStaffSyncStatus = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const configSnap = await db.collection("staffImportConfigs").doc(companyId).get();
  const runsSnap = await db.collection("staffImportRuns")
    .where("companyId", "==", companyId)
    .orderBy("startedAt", "desc")
    .limit(10)
    .get();

  return {
    configured: configSnap.exists,
    enabled: configSnap.data()?.enabled === true,
    scheduleEnabled: configSnap.data()?.scheduleEnabled === true,
    markMissingInactive: configSnap.data()?.markMissingInactive === true,
    lastRuns: runsSnap.docs.map((doc) => ({
      id: doc.id,
      ...serializeData(doc.data()),
    })),
  };
});

async function executeStaffImport(
  companyId: string,
  mode: ImportMode,
  requestedSheets?: string[]
): Promise<ImportResult> {
  if (mode === "commit") await assertProductionOperational(companyId);
  const config = await loadConfig(companyId);
  if (!config.enabled && mode === "commit") {
    throw new HttpsError(
      "failed-precondition",
      "スタッフ名簿同期設定が無効です。"
    );
  }

  const lock = mode === "commit" ? await acquireLock(companyId) : null;
  let runRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    if (mode === "commit") {
      runRef = db.collection("staffImportRuns").doc();
      await runRef.set({
        companyId,
        mode,
        status: "processing",
        spreadsheetId: config.spreadsheetId,
        requestedSheets: requestedSheets ?? [],
        configVersion: config.configVersion,
        startedAt: FieldValue.serverTimestamp(),
      });
    }

    const sheets = await createReadOnlySheetsClient();
    const descriptors = await listSpreadsheetSheets(sheets, config.spreadsheetId);
    const targets = selectNamedSheets(
      descriptors,
      config.activeSheets,
      config.excludedSheets,
      requestedSheets,
      config.maxSheetsPerRun
    );

    const expectedSheets = new Set(config.activeSheets.filter(name => !config.excludedSheets.includes(name)));
    const completeSelection = expectedSheets.size > 0 && targets.length === expectedSheets.size
      && new Set(targets.map(target => target.title)).size === expectedSheets.size
      && targets.every(target => expectedSheets.has(target.title));
    const completeRows = targets.every(target => Number.isSafeInteger(target.rowCount)
      && target.rowCount > 0 && target.rowCount <= config.maxRowsPerSheet);
    if (mode === "commit" && (!completeSelection || !completeRows)) {
      throw new HttpsError("failed-precondition",
        "対象のスタッフタブを全件読み取れることを確認できません。タブの不足・非表示・部分指定・読取上限を確認して同期を再実行してください。");
    }
    if (!targets.length) {
      throw new HttpsError(
        "not-found",
        "マスタ・東北など、対象の現役スタッフタブが見つかりません。"
      );
    }

    const allRows = [];
    const summaries: StaffSheetSummary[] = [];
    const warnings: string[] = [];
    if (!completeSelection) warnings.push("一部の対象タブだけを表示しています。この範囲では名簿同期できません。");
    if (!completeRows) warnings.push("読取上限または行数不明のタブがあります。全行を確認できるまで名簿同期できません。");
    let failedSheets = 0;

    for (const target of targets) {
      try {
        if ((config.headerRow != null && config.headerRow > target.rowCount)
          || (config.dataStartRow != null && config.dataStartRow > target.rowCount + 1)) {
          throw new Error("ヘッダー行またはデータ開始行がシートの行数を超えています。");
        }
        const values = await readNamedSheet(
          sheets,
          config.spreadsheetId,
          target,
          config.readRangeEndColumn,
          config.maxRowsPerSheet
        );
        const parsed = parseStaffSheet(
          config.spreadsheetId,
          target.title,
          values,
          config
        );
        allRows.push(...parsed.rows);
        summaries.push(parsed.summary);
        warnings.push(...parsed.summary.warnings);
      } catch (error) {
        failedSheets++;
        const message = `${target.title}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        warnings.push(message);
        summaries.push({
          sheetName: target.title,
          headerRow: 0,
          dataStartRow: 0,
          rowsRead: 0,
          staffRows: 0,
          invalidEmailCount: 0,
          warnings: [message],
        });
      }
    }

    const merged = mergeStaffRows(allRows);
    warnings.push(...merged.warnings);

    let commitStats = {
      emailConflicts: 0,
      activated: 0,
      inactivated: 0,
      emailIndexesWritten: 0,
      sessionsRevoked: 0,
      firestoreWrites: 0,
    };

    if (mode === "commit") {
      if (failedSheets > 0) {
        throw new HttpsError(
          "failed-precondition",
          "一部タブの読取に失敗したため、誤停止防止のため同期を中止しました。"
        );
      }
      if (!lock) throw new HttpsError("aborted", "スタッフ名簿同期の実行権限がありません。");
      commitStats = await writeStaffDirectory(
        companyId,
        merged.profiles,
        config,
        runRef?.id ?? "",
        lock
      );
    }

    const totals = {
      sheets: summaries.length,
      sourceRows: allRows.length,
      profiles: merged.profiles.length,
      multipleEmailProfiles: merged.profiles.filter(
        (profile) => profile.emails.length > 1
      ).length,
      profilesWithoutEmail: merged.profiles.filter(
        (profile) => profile.emails.length === 0
      ).length,
      invalidEmails: merged.profiles.reduce(
        (sum, profile) => sum + profile.invalidEmails.length,
        0
      ),
      profileConflicts: merged.profiles.reduce(
        (sum, profile) => sum + profile.conflictWarnings.length,
        0
      ),
      ...commitStats,
    };

    const result: ImportResult = {
      runId: runRef?.id ?? null,
      mode,
      companyId,
      sheets: summaries,
      totals,
      warnings: warnings.slice(0, 300),
      samples: merged.profiles.slice(0, 20).map((profile) => ({
        staffId: profile.staffId,
        displayName: profile.displayName,
        emails: profile.emails,
        areaLabels: profile.areaLabels,
        active: profile.active,
      })),
    };

    if (runRef) {
      await runRef.set({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        totals,
        warnings: result.warnings,
        sheets: summaries,
      }, { merge: true });
    }

    return result;
  } catch (error) {
    if (runRef) {
      await runRef.set({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError(
      "internal",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (lock) await releaseLock(lock);
  }
}

async function writeStaffDirectory(
  companyId: string,
  profiles: MergedStaffProfile[],
  config: StaffImportConfig,
  runId: string,
  lock: StaffImportLock
): Promise<{
  emailConflicts: number;
  activated: number;
  inactivated: number;
  emailIndexesWritten: number;
  sessionsRevoked: number;
  firestoreWrites: number;
}> {
  const existingSnap = await db.collection("staffProfiles")
    .where("companyId", "==", companyId)
    .get();
  const existing = new Map(existingSnap.docs.map((doc) => [doc.id, doc.data()]));
  const incomingIds = new Set(profiles.map((profile) => profile.staffId));
  const incomingEmailHashes = profiles.flatMap((profile) =>
    profile.emails.map((email) => emailHash(email))
  );
  const emailIndexes = await fetchDocuments("emailIndex", incomingEmailHashes);
  const ownedIndexSnap = await db.collection("emailIndex").where("companyId", "==", companyId).get();
  const activeIndexesByStaff = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const index of ownedIndexSnap.docs) {
    const data = index.data();
    if (data.active !== true || typeof data.staffId !== "string") continue;
    const indexes = activeIndexesByStaff.get(data.staffId) ?? [];
    indexes.push(index);
    activeIndexesByStaff.set(data.staffId, indexes);
  }
  const writer = new BatchWriter(companyId, lock);
  const now = Timestamp.now();
  const revocations: Array<{ uid: string; staffId: string; emailHash: string; reason: string }> = [];
  let emailConflicts = 0;
  let activated = 0;
  let inactivated = 0;
  let emailIndexesWritten = 0;

  for (const profile of profiles) {
    const old = existing.get(profile.staffId);
    const acceptedEmails: string[] = [];
    const conflictEmails: string[] = [];

    for (const email of profile.emails) {
      const hash = emailHash(email);
      const index = emailIndexes.get(hash);
      if (index && (index.companyId !== companyId || index.staffId !== profile.staffId)) {
        emailConflicts++;
        conflictEmails.push(email);
        continue;
      }
      acceptedEmails.push(email);
      emailIndexes.set(hash, { companyId, staffId: profile.staffId });
    }

    const isActive = profile.active;
    const acceptedHashes = new Set(acceptedEmails.map(emailHash));
    if (!isActive || config.revokeRemovedEmailSessions) {
      const identities = await getProfileAuthIdentities(companyId, profile.staffId);
      for (const identity of identities) {
        if (!isActive || !acceptedHashes.has(identity.emailHash)) {
          revocations.push({ ...identity, staffId: profile.staffId,
            reason: isActive ? "staff.email.removed" : "staff.inactivated" });
        }
      }
    }
    const wasActive = old?.active === true;
    if (isActive && !wasActive) activated++;
    if (!isActive && wasActive) inactivated++;

    const profileRef = db.collection("staffProfiles").doc(profile.staffId);
    const profileData: FirebaseFirestore.DocumentData = {
      companyId,
      displayName: profile.displayName,
      normalizedName: profile.normalizedName,
      emails: acceptedEmails,
      primaryEmail: acceptedEmails[0] ?? "",
      emailCount: acceptedEmails.length,
      emailConflicts: conflictEmails,
      invalidEmails: profile.invalidEmails,
      phone: profile.phone,
      homePrefecture: profile.homePrefecture,
      nearestStation: profile.nearestStation,
      birthDateRaw: profile.birthDateRaw,
      areaLabels: profile.areaLabels,
      active: isActive,
      sourceMissing: false,
      sourceRefs: profile.sourceRefs,
      profileConflicts: profile.conflictWarnings,
      sync: {
        runId,
        configVersion: config.configVersion,
        lastSeenAt: now,
        source: "google_sheets_readonly",
      },
      updatedAt: now,
    };

    if (!old) {
      profileData.createdAt = now;
      profileData.rank = profile.rank || "A";
      profileData.evaluationTags = profile.evaluationTags;
      profileData.evaluationMemo = profile.evaluationMemo;
    } else {
      if (!old.rank && profile.rank) profileData.rank = profile.rank;
      if (!old.evaluationTags && profile.evaluationTags.length) {
        profileData.evaluationTags = profile.evaluationTags;
      }
      if (!old.evaluationMemo && profile.evaluationMemo) {
        profileData.evaluationMemo = profile.evaluationMemo;
      }
    }

    await writer.set(profileRef, profileData, { merge: true });

    for (const email of acceptedEmails) {
      const hash = emailHash(email);
      await writer.set(db.collection("emailIndex").doc(hash), {
        companyId,
        staffId: profile.staffId,
        email,
        active: isActive,
        source: "staff.import",
        updatedAt: now,
      }, { merge: true }, "claim");
      emailIndexesWritten++;
    }

    for (const index of activeIndexesByStaff.get(profile.staffId) ?? []) {
      if (acceptedHashes.has(index.id)) continue;
      await writer.set(index.ref, {
        companyId, staffId: profile.staffId, active: false, removedAt: now, updatedAt: now,
      }, { merge: true }, "release");
    }
  }

  if (config.markMissingInactive) {
    for (const [staffId, old] of existing.entries()) {
      if (incomingIds.has(staffId)) continue;
      const identities = await getProfileAuthIdentities(companyId, staffId);
      for (const identity of identities) {
        revocations.push({ ...identity, staffId, reason: "staff.inactivated" });
      }
      if (old.active === true) {
        inactivated++;
        await writer.set(db.collection("staffProfiles").doc(staffId), {
          active: false, sourceMissing: true, inactivatedAt: now,
          inactivationReason: "not_found_in_active_staff_sheets", updatedAt: now,
        }, { merge: true });
      }
      for (const index of activeIndexesByStaff.get(staffId) ?? []) {
        await writer.set(index.ref, {
          companyId, staffId, active: false, updatedAt: now,
        }, { merge: true }, "release");
      }
    }
  }
  await writer.flush();

  let sessionsRevoked = 0, sessionsFailed = 0;
  const uniqueRevocations = new Map(revocations.map(item => [item.uid, item]));
  for (const item of uniqueRevocations.values()) {
    try {
      const identityRef = db.collection("authIdentities").doc(item.uid);
      const profileRef = db.collection("staffProfiles").doc(item.staffId);
      const matches = (identity: FirebaseFirestore.DocumentData | undefined,
        profile: FirebaseFirestore.DocumentData | undefined) => identity?.companyId === companyId
        && identity.staffId === item.staffId && identity.emailHash === item.emailHash
        && profile?.companyId === companyId;
      const required = (profile: FirebaseFirestore.DocumentData) => item.reason === "staff.inactivated"
        ? profile.active !== true
        : !Array.isArray(profile.emails) || !profile.emails.some((email: unknown) =>
          typeof email === "string" && emailHash(email) === item.emailHash);
      const [identity, profile] = await Promise.all([identityRef.get(), profileRef.get()]);
      if (!matches(identity.data(), profile.data())) throw new Error("Staff revocation identity changed");
      if (!required(profile.data()!)) continue;
      assertStaffImportLease((await lock.ref.get()).data(), companyId, lock.token);
      await auth.revokeRefreshTokens(item.uid);
      await db.runTransaction(async tx => {
        assertStaffImportLease((await tx.get(lock.ref)).data(), companyId, lock.token);
        const [latestIdentity, latestProfile] = await Promise.all([tx.get(identityRef), tx.get(profileRef)]);
        if (!matches(latestIdentity.data(), latestProfile.data()) || !required(latestProfile.data()!)) {
          throw new Error("Staff revocation identity changed");
        }
        tx.update(identityRef, {
          active: false, revokedAt: FieldValue.serverTimestamp(), revokeReason: item.reason,
        });
      });
      sessionsRevoked++;
    } catch {
      sessionsFailed++;
    }
  }
  if (sessionsFailed) {
    throw new HttpsError("unavailable",
      "名簿の保存は完了しましたが、認証解除が一部完了していません。スタッフ名簿同期を再実行してください。",
      { operation: "staff-import-revoke", directoryWritten: true, sessionsRevoked, sessionsFailed, retryable: true });
  }
  return {
    emailConflicts,
    activated,
    inactivated,
    emailIndexesWritten,
    sessionsRevoked,
    firestoreWrites: writer.writeCount,
  };
}

async function getProfileAuthIdentities(companyId: string, staffId: string): Promise<Array<{
  uid: string;
  emailHash: string;
}>> {
  const profile = await db.collection("staffProfiles").doc(staffId).get();
  if (!profile.exists) return [];
  const invalid = () => new HttpsError("failed-precondition", "スタッフの認証登録情報を確認できません。登録情報を確認して同期を再実行してください。");
  if (profile.data()?.companyId !== companyId) throw invalid();
  const authUids = profile.data()?.authUids ?? [];
  if (!Array.isArray(authUids) || authUids.some(uid => typeof uid !== "string" || !uid.trim()
    || /[\/\\\u0000-\u001f\u007f]/.test(uid))) throw invalid();
  if (!authUids.length) return [];
  const snaps = await db.getAll(...[...new Set(authUids as string[])].map(uid => db.collection("authIdentities").doc(uid)));
  return snaps.flatMap(snap => {
    const identity = snap.data();
    if (!identity || identity.companyId !== companyId || identity.staffId !== staffId
      || typeof identity.emailHash !== "string" || !identity.emailHash) throw invalid();
    if (identity.active === false && identity.revokedAt instanceof Timestamp) return [];
    return [{ uid: snap.id, emailHash: identity.emailHash }];
  });
}

async function fetchDocuments(
  collectionName: string,
  ids: string[]
): Promise<Map<string, FirebaseFirestore.DocumentData>> {
  const result = new Map<string, FirebaseFirestore.DocumentData>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 250) {
    const refs = unique.slice(index, index + 250)
      .map((id) => db.collection(collectionName).doc(id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) result.set(snap.id, snap.data() ?? {});
    }
  }
  return result;
}

type StaffImportLock = {
  ref: FirebaseFirestore.DocumentReference;
  token: string;
};

// 各書込トランザクションで再確認し、失効・交代した同期による上書きを防ぐ。
function assertStaffImportLease(
  lease: FirebaseFirestore.DocumentData | undefined,
  companyId: string,
  token: string
): void {
  if (!lease || lease.companyId !== companyId || lease.token !== token
    || !(lease.leaseUntil instanceof Timestamp) || lease.leaseUntil.toMillis() <= Timestamp.now().toMillis()) {
    throw new HttpsError("aborted", "スタッフ名簿同期の実行権限が失効しました。再実行してください。");
  }
}

class BatchWriter {
  constructor(private readonly companyId: string, private readonly lock: StaffImportLock) {}

  private pending: Array<{
    ref: FirebaseFirestore.DocumentReference;
    data: FirebaseFirestore.DocumentData;
    options: FirebaseFirestore.SetOptions;
    emailAction?: "claim" | "release";
  }> = [];
  public writeCount = 0;

  async set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: FirebaseFirestore.SetOptions,
    emailAction?: "claim" | "release"
  ): Promise<void> {
    this.pending.push({ ref, data, options, ...(emailAction ? { emailAction } : {}) });
    if (this.pending.length >= 350) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.pending.length) return;
    const pending = this.pending;
    const committed = await db.runTransaction(async tx => {
      assertStaffImportLease((await tx.get(this.lock.ref)).data(), this.companyId, this.lock.token);
      const refs = new Map(pending.filter(item => item.emailAction).map(item => [item.ref.path, item.ref]));
      const snapshots = await Promise.all([...refs.values()].map(ref => tx.get(ref)));
      const owners = new Map(snapshots.map(snap => [snap.ref.path, snap.data()]));
      let count = 0;
      for (const item of pending) {
        const current = owners.get(item.ref.path);
        const owned = current?.companyId === item.data.companyId && current?.staffId === item.data.staffId;
        if (item.emailAction === "release") {
          if (!current || !owned) continue;
          tx.update(item.ref, item.data);
          owners.set(item.ref.path, { ...current, ...item.data });
        } else {
          if (item.emailAction === "claim" && current && !owned) {
            throw new HttpsError("aborted", "メールの登録先が変更されています。スタッフ名簿同期を再実行してください。");
          }
          tx.set(item.ref, item.data, item.options);
          if (item.emailAction) owners.set(item.ref.path, { ...current, ...item.data });
        }
        count++;
      }
      return count;
    });
    this.writeCount += committed;
    this.pending = [];
  }
}
async function loadConfig(companyId: string): Promise<StaffImportConfig> {
  const snap = await db.collection("staffImportConfigs").doc(companyId).get();
  if (!snap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "staffImportConfigsに会社設定がありません。"
    );
  }

  const stored = snap.data()!;
  if (stored.companyId !== undefined && stored.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "スタッフ名簿同期設定の会社が一致しません。");
  }
  const parsed = ConfigSchema.safeParse({ ...stored, companyId });
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      "スタッフ名簿同期設定が不正です。",
      parsed.error.flatten()
    );
  }
  try {
    const endIndex = columnLetterToIndex(parsed.data.readRangeEndColumn);
    if (!Number.isSafeInteger(endIndex) || endIndex < 0) throw new Error("invalid end");
    for (const [key, column] of Object.entries(parsed.data.columns)) {
      if (!column?.trim() && key !== "displayName" && key !== "email") continue;
      const index = columnLetterToIndex(column ?? "");
      if (!Number.isSafeInteger(index) || index < 0 || index > endIndex) throw new Error("invalid column");
    }
    if (columnLetterToIndex(parsed.data.columns.displayName)
      === columnLetterToIndex(parsed.data.columns.email)) throw new Error("duplicate required column");
  } catch {
    throw new HttpsError("failed-precondition", "スタッフ名簿の列設定が読取範囲と一致しません。");
  }
  return parsed.data as StaffImportConfig;
}

async function acquireLock(companyId: string): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}> {
  const ref = db.collection("syncLocks").doc(`${companyId}_staff_import`);
  const token = db.collection("_ids").doc().id;
  await db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const leaseUntil = Timestamp.fromMillis(now.toMillis() + 10 * 60 * 1000);
    const snap = await tx.get(ref);
    const currentLease = snap.data()?.leaseUntil as Timestamp | undefined;
    if (currentLease && currentLease.toMillis() > now.toMillis()) {
      throw new HttpsError(
        "already-exists",
        "別のスタッフ名簿同期が実行中です。"
      );
    }
    tx.set(ref, { companyId, token, acquiredAt: now, leaseUntil });
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

function serializeData(
  value: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  const result: FirebaseFirestore.DocumentData = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = item instanceof Timestamp
      ? item.toDate().toISOString()
      : item;
  }
  return result;
}
