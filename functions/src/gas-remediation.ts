import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { scanSourcesForSecrets } from "./gas-secret-scan-core";
import {
  compareAuditFindings,
  FindingStatus,
  markdownAuditReport,
  remediationProgress,
} from "./gas-remediation-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";

const FileSchema = z.object({
  filename: z.string().min(1).max(200),
  source: z.string().max(2_000_000),
});

export const scanGasUploadSafety = onCall(async (request) => {
  requireAdmin(request);
  const input = z.object({
    files: z.array(FileSchema).min(1).max(100),
  }).parse(request.data ?? {});
  return scanSourcesForSecrets(input.files);
});

export const saveGasRemediation = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    gasAuditId: z.string().min(10),
    findingId: z.string().min(3),
    status: z.enum([
      "open", "in_progress", "fixed",
      "accepted_risk", "false_positive",
    ]),
    owner: z.string().max(100).default(""),
    note: z.string().max(3000).default(""),
    fixedInFile: z.string().max(200).optional(),
  }).parse(request.data ?? {});

  const audit = await db.collection("gasAuditRuns")
    .doc(input.gasAuditId).get();
  if (!audit.exists || audit.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "監査結果が見つかりません。");
  }

  const findingExists = (
    audit.data()?.report?.findings ?? []
  ).some((finding: { id?: string }) => finding.id === input.findingId);
  if (!findingExists) {
    throw new HttpsError("not-found", "指摘項目が見つかりません。");
  }

  const ref = db.collection("gasRemediations").doc(
    `${input.gasAuditId}_${safeId(input.findingId)}`
  );
  await ref.set({
    companyId,
    gasAuditId: input.gasAuditId,
    findingId: input.findingId,
    status: input.status,
    owner: input.owner,
    note: input.note,
    fixedInFile: input.fixedInFile ?? null,
    updatedBy: session.uid,
    updatedAt: FieldValue.serverTimestamp(),
    ...(input.status === "fixed"
      ? { fixedAt: FieldValue.serverTimestamp() }
      : {}),
  }, { merge: true });

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "gas.remediation.update",
    gasAuditId: input.gasAuditId,
    findingId: input.findingId,
    status: input.status,
    requestId: requestId("audit"),
    createdAt: FieldValue.serverTimestamp(),
  });

  return { saved: true };
});

export const getGasAuditDetail = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    gasAuditId: z.string().min(10),
  }).parse(request.data ?? {});

  const [audit, remediationSnap] = await Promise.all([
    db.collection("gasAuditRuns").doc(input.gasAuditId).get(),
    db.collection("gasRemediations")
      .where("companyId", "==", companyId)
      .where("gasAuditId", "==", input.gasAuditId)
      .get(),
  ]);

  if (!audit.exists || audit.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "監査結果が見つかりません。");
  }

  const report = audit.data()?.report;
  const remediations = remediationSnap.docs.map((doc) => {
    const data = serialize(doc.data());
    return {
      ...data,
      id: doc.id,
      findingId: String(data.findingId ?? ""),
      status: findingStatus(data.status),
      owner: String(data.owner ?? ""),
      note: String(data.note ?? ""),
      fixedInFile: data.fixedInFile
        ? String(data.fixedInFile)
        : undefined,
      fixedAt: data.fixedAt ? String(data.fixedAt) : undefined,
    };
  });

  return {
    gasAuditId: audit.id,
    report,
    remediations,
    progress: remediationProgress(
      report?.findings ?? [],
      remediations
    ),
  };
});

export const compareGasAudits = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    beforeAuditId: z.string().min(10),
    afterAuditId: z.string().min(10),
  }).parse(request.data ?? {});

  const [before, after] = await Promise.all([
    db.collection("gasAuditRuns").doc(input.beforeAuditId).get(),
    db.collection("gasAuditRuns").doc(input.afterAuditId).get(),
  ]);
  if (
    !before.exists || !after.exists ||
    before.data()?.companyId !== companyId ||
    after.data()?.companyId !== companyId
  ) {
    throw new HttpsError("not-found", "比較する監査結果がありません。");
  }

  const delta = compareAuditFindings(
    before.data()?.report,
    after.data()?.report
  );
  const ref = db.collection("gasAuditComparisons").doc();
  await ref.set({
    companyId,
    actorUid: session.uid,
    beforeAuditId: input.beforeAuditId,
    afterAuditId: input.afterAuditId,
    delta,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { comparisonId: ref.id, delta };
});

export const exportGasAuditMarkdown = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    gasAuditId: z.string().min(10),
  }).parse(request.data ?? {});

  const audit = await db.collection("gasAuditRuns")
    .doc(input.gasAuditId).get();
  if (!audit.exists || audit.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "監査結果が見つかりません。");
  }

  const report = audit.data()?.report;
  return {
    filename: `GAS監査_${input.gasAuditId}.md`,
    markdown: markdownAuditReport({
      title: "Lip Knots Crew GAS監査レポート",
      grade: String(report?.grade ?? "E"),
      score: Number(report?.score ?? 0),
      blockers: Number(report?.blockers ?? 0),
      findings: report?.findings ?? [],
    }),
  };
});

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 500);
}

function findingStatus(value: unknown): FindingStatus {
  switch (value) {
    case "in_progress":
    case "fixed":
    case "accepted_risk":
    case "false_positive":
      return value;
    default:
      return "open";
  }
}

function serialize(
  data: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    value instanceof Timestamp ? value.toDate().toISOString() : value,
  ]));
}
