import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import {
  applySafePatches,
  generatePatchPlan,
  unifiedDiff,
} from "./gas-patch-core";
import {
  defaultRegressionCases,
  summarizeRegression,
} from "./gas-regression-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";

const FileSchema = z.object({
  filename: z.string().min(1).max(200),
  source: z.string().max(2_000_000),
});

export const generateGasPatchPlan = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    gasAuditId: z.string().min(10),
    files: z.array(FileSchema).min(1).max(100),
  }).parse(request.data ?? {});

  const audit = await db.collection("gasAuditRuns").doc(input.gasAuditId).get();
  if (!audit.exists || audit.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "監査結果が見つかりません。");
  }

  const plan = generatePatchPlan({
    files: input.files,
    findings: audit.data()?.report?.findings ?? [],
  });
  const ref = db.collection("gasPatchPlans").doc();
  await ref.set({
    companyId,
    actorUid: session.uid,
    gasAuditId: input.gasAuditId,
    plan,
    createdAt: FieldValue.serverTimestamp(),
  });

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "gas.patch.plan.generate",
    gasAuditId: input.gasAuditId,
    patchPlanId: ref.id,
    suggestions: plan.suggestions.length,
    requestId: requestId("audit"),
    createdAt: FieldValue.serverTimestamp(),
  });

  return { patchPlanId: ref.id, plan };
});

export const previewGasPatch = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    patchPlanId: z.string().min(10),
    filename: z.string().min(1).max(200),
    source: z.string().max(2_000_000),
    suggestionIds: z.array(z.string()).max(500),
  }).parse(request.data ?? {});

  const planSnap = await db.collection("gasPatchPlans")
    .doc(input.patchPlanId).get();
  if (!planSnap.exists || planSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "修正計画が見つかりません。");
  }
  const suggestions = (planSnap.data()?.plan?.suggestions ?? [])
    .filter((item: { id?: string; filename?: string }) =>
      input.suggestionIds.includes(String(item.id)) &&
      item.filename === input.filename
    );
  const patched = applySafePatches({
    source: input.source,
    suggestions,
  });
  return {
    ...patched,
    diff: unifiedDiff(input.filename, input.source, patched.source),
  };
});

export const getRegressionTemplate = onCall((request) => {
  requireAdmin(request);
  return { cases: defaultRegressionCases() };
});

export const saveRegressionRun = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = z.object({
    gasAuditId: z.string().min(10),
    results: z.array(z.object({
      caseId: z.string(),
      status: z.enum(["not_run", "passed", "failed", "blocked"]),
      actual: z.string().max(1000).default(""),
      evidence: z.array(z.string().max(500)).max(20).default([]),
      note: z.string().max(3000).default(""),
    })).max(100),
  }).parse(request.data ?? {});

  const cases = defaultRegressionCases();
  const summary = summarizeRegression(cases, input.results);
  const ref = db.collection("gasRegressionRuns").doc();
  await ref.set({
    companyId,
    actorUid: session.uid,
    gasAuditId: input.gasAuditId,
    cases,
    results: input.results,
    summary,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { runId: ref.id, summary };
});
