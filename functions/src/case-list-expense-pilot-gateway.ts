import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { auth, db } from "./firebase";
import { completeAuthorizedExternalExpense, readAuthorizedExternalExpense } from "./admin-operations";
import { resolveExternalCaseListSheetRef, type readExternalCaseListExpenses } from "./case-list-external-transfer";
import { externalTransferMode } from "./case-list-external-mode";
import { assertProductionOperational, getProductionOperationalState } from "./system-safety";
import { canStartExternalExpenseWrite, reconcileAuthorizedExpense, traceExternalExpense, type ExternalExpenseAtomicWriter, type ExternalExpenseIntent } from "./case-list-external-expense-completion";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const caseId = z.string().regex(/^LKCASE_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const channel = z.enum(["crew", "gas", "manual"]);
const pilotPolicy = z.object({
  enabled: z.literal(true), mode: z.enum(["preflight", "exercise"]),
  pilotId: id, projectId: id, companyId: id, jobId: id, caseId, staffId: id,
  dateKey: z.iso.date(), jobRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  spreadsheetId: id, sheetId: z.number().int().min(0).max(0x7fffffff),
  validUntilMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  principals: z.object({ crew: id, gas: id, manual: id }).strict()
    .refine(principals => new Set(Object.values(principals)).size === 3),
}).strict();
export type ExpensePilotPolicy = z.input<typeof pilotPolicy>;
export type ExpensePilotBookReader = Pick<ExternalExpenseAtomicWriter, "readReceipt"> & {
  assertWriteAccess(companyId: string): Promise<string>;
  readObservation?: typeof readExternalCaseListExpenses;
};
type Claims = Record<string, unknown>;
type Runtime = {
  projectId?: string;
  environment?: string;
  verifyIdToken(token: string, checkRevoked: true): Promise<Claims>;
};

const money = z.number().min(0).max(10_000_000).nullable();
const base = z.object({ pilotId: id, jobId: id });
const operationId = z.uuid().regex(/^[0-9a-f-]+$/);
const command = z.discriminatedUnion("action", [
  base.extend({ action: z.literal("read") }).strict(),
  base.extend({ action: z.literal("trace"), operationId }).strict(),
  base.extend({ action: z.literal("reconcile"), operationId }).strict(),
  base.extend({
    action: z.literal("complete"), operationId, expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
    values: z.object({ transportation: money, purchase8: money, purchase10: money, netPrintCost: money, postageCost: money }).strict(),
    note: z.string().max(3000).default(""),
  }).strict(),
]);
const deny = () => new HttpsError("permission-denied", "許可された試験用アカウントと対象案件を確認してください。");
const invalidScope = () => new HttpsError("failed-precondition", "承認された試験案件・担当・月別表を確認できません。");

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Unregistered entry for an approved, isolated single-case pilot. */
export function createExpensePilotGateway(config: ExpensePilotPolicy, runtime: Runtime, book: ExpensePilotBookReader | ExternalExpenseAtomicWriter) {
  const policy = pilotPolicy.parse(config);
  const assertWriteAccess = book.assertWriteAccess?.bind(book);
  const readObservation = book.readObservation?.bind(book);
  const writer = policy.mode === "exercise" && "compareAndWrite" in book ? book : undefined;
  if (runtime.projectId !== policy.projectId || !["staging", "development"].includes(runtime.environment ?? "") ||
      !assertWriteAccess || (policy.mode === "exercise" &&
        (!writer?.compareAndWrite || !writer.stageReservation || !writer.stageVerifiedReceipt))) throw invalidScope();
  const bookMatches = (ref: FirebaseFirestore.DocumentData) => ref?.spreadsheetId === policy.spreadsheetId &&
    ref.sheetId === policy.sheetId && ref.caseId === policy.caseId;
  const matchesIntent = (intent: ExternalExpenseIntent) => intent.companyId === policy.companyId &&
    intent.jobId === policy.jobId && intent.staffId === policy.staffId && intent.dateKey === policy.dateKey &&
    intent.jobRevision === policy.jobRevision && bookMatches(intent.sheetRef);
  const checkApproval = () => { if (Date.now() >= policy.validUntilMs) throw invalidScope(); };

  async function authenticate(authorization: unknown) {
    checkApproval();
    if (typeof authorization !== "string" || authorization.length > 16_384 ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) throw deny();
    let claims: Claims;
    try { claims = await runtime.verifyIdToken(authorization.slice(7), true); }
    catch { throw deny(); }
    const transport = channel.safeParse(claims.expensePilotChannel);
    if (!transport.success) throw deny();
    const uid = policy.principals[transport.data];
    const now = Math.floor(Date.now() / 1000);
    if (claims.uid !== uid || claims.sub !== uid || claims.aud !== policy.projectId ||
        claims.iss !== "https://securetoken.google.com/" + policy.projectId || claims.companyId !== policy.companyId ||
        claims.expensePilotId !== policy.pilotId || claims.role !== (transport.data === "crew" ? "admin" : "expense_pilot") ||
        !timestamp(claims.exp) || !timestamp(claims.iat) || !timestamp(claims.auth_time) ||
        claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 3600 ||
        claims.iat > now + 30 || claims.auth_time > claims.iat ||
        (claims.firebase as { tenant?: unknown } | undefined)?.tenant != null) throw deny();
    checkApproval();
    return { uid, transport: transport.data, authTime: claims.auth_time, expires: claims.exp };
  }

  async function loadJob() {
    const job = (await db.collection("jobs").doc(policy.jobId).get()).data();
    if (!job?.caseListSource || job.companyId !== policy.companyId || job.caseId !== policy.caseId ||
        job.assignedStaffId !== policy.staffId || job.dateKey !== policy.dateKey || job.revision !== policy.jobRevision ||
        job.cancelled === true || job.status !== "assigned") throw invalidScope();
    const reference = await resolveExternalCaseListSheetRef(policy.companyId, policy.jobId, job);
    if (!bookMatches(reference)) throw invalidScope();
    return job;
  }

  return async (authorization: unknown, data: unknown) => {
    const caller = await authenticate(authorization);
    const input = command.parse(data);
    if (input.pilotId !== policy.pilotId || input.jobId !== policy.jobId) throw deny();
    if (!writer && (input.action === "complete" || input.action === "reconcile")) throw invalidScope();
    const job = await loadJob();
    const refresh = async () => {
      const current = await authenticate(authorization);
      if (current.uid !== caller.uid || current.transport !== caller.transport || current.authTime !== caller.authTime) throw deny();
    };
    if (input.action === "read" || input.action === "trace") {
      const version = await assertWriteAccess(policy.companyId);
      if (typeof version !== "string" || !/^[1-9][0-9]*$/.test(version)) throw invalidScope();
      await refresh();
      const result = input.action === "read"
        ? await readAuthorizedExternalExpense(policy.companyId, policy.jobId, job, readObservation)
        : await traceExternalExpense(policy.companyId, policy.jobId, job, input.operationId, book, matchesIntent, readObservation);
      if (await assertWriteAccess(policy.companyId) !== version) throw invalidScope();
      await loadJob();
      await refresh();
      return result;
    }

    if (!writer) throw invalidScope();
    await assertProductionOperational(policy.companyId);
    const assertIntent = (intent: ExternalExpenseIntent) => {
      checkApproval();
      if (!matchesIntent(intent) || caller.expires * 1000 <= Date.now()) throw invalidScope();
    };
    async function revalidateDispatch(intent: ExternalExpenseIntent) {
      const assertDispatchAllowed = () => {
        assertIntent(intent);
        if (!canStartExternalExpenseWrite()) throw invalidScope();
      };
      assertIntent(intent);
      await loadJob();
      await assertProductionOperational(policy.companyId);
      await refresh();
      assertDispatchAllowed();
      return assertDispatchAllowed;
    }
    const guarded: ExternalExpenseAtomicWriter = {
      ...writer,
      ...(readObservation ? {
        async readObservation(companyId: string, jobId: string, currentJob: FirebaseFirestore.DocumentData) {
          await refresh();
          const observation = await readObservation(companyId, jobId, currentJob);
          await refresh();
          return observation;
        },
      } : {}),
      async assertWriteAccess(companyId) {
        await refresh();
        await writer.assertWriteAccess!(companyId);
      },
      async stageReservation(tx, intent) {
        assertIntent(intent);
        await writer.stageReservation!(tx, intent);
      },
      async compareAndWrite(intent) {
        await revalidateDispatch(intent);
        await writer.compareAndWrite(intent, () => revalidateDispatch(intent));
      },
      async recordUnissuedExpiry(intent) {
        assertIntent(intent);
        await refresh();
        await writer.recordUnissuedExpiry?.(intent);
      },
      async readReceipt(operationId) {
        await refresh();
        return writer.readReceipt(operationId);
      },
      async stageVerifiedReceipt(tx, intent, receipt) {
        if (!(await getProductionOperationalState(policy.companyId, tx)).operational || externalTransferMode() === "read-only") throw invalidScope();
        assertIntent(intent);
        await writer.stageVerifiedReceipt!(tx, intent, receipt);
      },
    };
    const result = input.action === "reconcile"
      ? await reconcileAuthorizedExpense(policy.companyId, policy.jobId, job, caller.uid, input.operationId, matchesIntent, guarded)
      : await completeAuthorizedExternalExpense(policy.companyId, caller.uid, job, input, input.values, guarded);
    return { ...result, operationId: input.operationId };
  };
}

export function connectExpensePilotGateway(config: ExpensePilotPolicy, connectBook: () => ExpensePilotBookReader | ExternalExpenseAtomicWriter) {
  const policy = pilotPolicy.parse(config);
  const environment = process.env.APP_ENVIRONMENT;
  const actualProjects = [auth.app.options.projectId, process.env.GCLOUD_PROJECT, process.env.GCP_PROJECT]
    .filter(project => project !== undefined);
  if (environment !== "staging" || process.env.EXPECTED_FIREBASE_PROJECT_ID !== policy.projectId ||
      !actualProjects.length || actualProjects.some(project => project !== policy.projectId)) throw invalidScope();

  return createExpensePilotGateway(policy, {
    projectId: policy.projectId,
    environment,
    verifyIdToken: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked),
  }, connectBook());
}
