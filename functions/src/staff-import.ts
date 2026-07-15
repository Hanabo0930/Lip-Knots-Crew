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
import { mergeStaffRows, parseStaffSheet } from "./staff-parser";
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

    if (!targets.length) {
      throw new HttpsError(
        "not-found",
        "マスタ・東北など、対象の現役スタッフタブが見つかりません。"
      );
    }

    const allRows = [];
    const summaries: StaffSheetSummary[] = [];
    const warnings: string[] = [];
    let failedSheets = 0;

    for (const target of targets) {
      try {
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
      if (failedSheets > 0 && config.markMissingInactive) {
        throw new HttpsError(
          "failed-precondition",
          "一部タブの読取に失敗したため、誤停止防止のため同期を中止しました。"
        );
      }
      commitStats = await writeStaffDirectory(
        companyId,
        merged.profiles,
        config,
        runRef?.id ?? ""
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
  runId: string
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
  const writer = new BatchWriter();
  const now = Timestamp.now();
  const revocations: Array<{ uid: string; reason: string }> = [];
  let emailConflicts = 0;
  let activated = 0;
  let inactivated = 0;
  let emailIndexesWritten = 0;

  for (const profile of profiles) {
    const old = existing.get(profile.staffId);
    const oldEmails = new Set(
      Array.isArray(old?.emails)
        ? old.emails.map((value: unknown) => String(value).toLowerCase())
        : []
    );

    const acceptedEmails: string[] = [];
    const conflictEmails: string[] = [];

    for (const email of profile.emails) {
      const hash = emailHash(email);
      const index = emailIndexes.get(hash);
      const indexedStaffId = typeof index?.staffId === "string"
        ? index.staffId
        : null;

      if (indexedStaffId && indexedStaffId !== profile.staffId) {
        emailConflicts++;
        conflictEmails.push(email);
        continue;
      }
      acceptedEmails.push(email);
    }

    const isActive = profile.active;
    const wasActive = old?.active === true;
    if (isActive && !wasActive) activated++;

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
      }, { merge: true });
      emailIndexesWritten++;
    }

    const removedEmails = [...oldEmails].filter(
      (email) => !acceptedEmails.includes(email)
    );
    for (const email of removedEmails) {
      const hash = emailHash(email);
      await writer.set(db.collection("emailIndex").doc(hash), {
        companyId,
        staffId: profile.staffId,
        email,
        active: false,
        removedAt: now,
        updatedAt: now,
      }, { merge: true });

      if (config.revokeRemovedEmailSessions) {
        const identities = await getProfileAuthIdentities(profile.staffId);
        for (const identity of identities) {
          if (identity.emailHash === hash) {
            revocations.push({
              uid: identity.uid,
              reason: "staff.email.removed",
            });
          }
        }
      }
    }
  }

  if (config.markMissingInactive) {
    for (const [staffId, old] of existing.entries()) {
      if (incomingIds.has(staffId) || old.active !== true) continue;
      inactivated++;

      await writer.set(db.collection("staffProfiles").doc(staffId), {
        active: false,
        sourceMissing: true,
        inactivatedAt: now,
        inactivationReason: "not_found_in_active_staff_sheets",
        updatedAt: now,
      }, { merge: true });

      const oldEmails = Array.isArray(old.emails)
        ? old.emails.map((value: unknown) => String(value).toLowerCase())
        : [];
      for (const email of oldEmails) {
        await writer.set(db.collection("emailIndex").doc(emailHash(email)), {
          companyId,
          staffId,
          email,
          active: false,
          updatedAt: now,
        }, { merge: true });
      }

      const authUids = Array.isArray(old.authUids)
        ? old.authUids.map((value: unknown) => String(value))
        : [];
      for (const uid of authUids) {
        revocations.push({ uid, reason: "staff.inactivated" });
      }
    }
  }

  await writer.flush();

  let sessionsRevoked = 0;
  const uniqueRevocations = new Map(
    revocations.map((item) => [item.uid, item])
  );
  for (const item of uniqueRevocations.values()) {
    try {
      await auth.revokeRefreshTokens(item.uid);
      await db.collection("authIdentities").doc(item.uid).set({
        active: false,
        revokedAt: FieldValue.serverTimestamp(),
        revokeReason: item.reason,
      }, { merge: true });
      sessionsRevoked++;
    } catch (error) {
      console.error("Failed to revoke staff session", item, error);
    }
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

async function getProfileAuthIdentities(staffId: string): Promise<Array<{
  uid: string;
  emailHash: string;
}>> {
  const profile = await db.collection("staffProfiles").doc(staffId).get();
  const authUids = Array.isArray(profile.data()?.authUids)
    ? profile.data()?.authUids.map((value: unknown) => String(value))
    : [];
  if (!authUids.length) return [];

  const snaps = await db.getAll(
    ...authUids.map((uid: string) => db.collection("authIdentities").doc(uid))
  );
  return snaps.flatMap((snap) => {
    if (!snap.exists) return [];
    return [{
      uid: snap.id,
      emailHash: String(snap.data()?.emailHash ?? ""),
    }];
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

class BatchWriter {
  private batch = db.batch();
  private pending = 0;
  public writeCount = 0;

  async set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: FirebaseFirestore.SetOptions
  ): Promise<void> {
    this.batch.set(ref, data, options);
    this.pending++;
    this.writeCount++;
    if (this.pending >= 350) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending === 0) return;
    await this.batch.commit();
    this.batch = db.batch();
    this.pending = 0;
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

  const parsed = ConfigSchema.safeParse({ companyId, ...snap.data() });
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      "スタッフ名簿同期設定が不正です。",
      parsed.error.flatten()
    );
  }
  return parsed.data as StaffImportConfig;
}

async function acquireLock(companyId: string): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}> {
  const ref = db.collection("syncLocks").doc(`${companyId}_staff_import`);
  const token = db.collection("_ids").doc().id;
  const now = Timestamp.now();
  const leaseUntil = Timestamp.fromMillis(now.toMillis() + 8 * 60 * 1000);

  await db.runTransaction(async (tx) => {
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
