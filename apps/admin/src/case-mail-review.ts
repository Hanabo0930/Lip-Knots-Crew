export type MailCommand = { mailIntake: { receiptId: string; candidateId: string; expectedReceiptRevision: number; expectedRevision: number; operationId: string } };
export type MailReceipt = { receiptId: string; revision: number; status: "ready" | "review" | "cancelled"; receivedAt: string | null; candidateCount: number; issues: string[] };
export type MailChangeValues = { workDate:string;clientName:string;storeName:string;makerName:string;menuName:string;entryTime:string;workTime:string;assignedStaffName:string;cancelled:boolean;cancellationFinancialTreatment:string };
export type MailChangeReview = { jobId:string;reviewVersion:string;canConfirm:boolean;resolved:boolean;issue:string|null;current:MailChangeValues;proposed:MailChangeValues|null };
export type MailReviewCommand = {receiptId:string;candidateId:string;jobId:string;reviewVersion:string;note:string;confirmed:true};
export type MailTargetCandidates = {state:"complete"|"limited"|"insufficient";items:{jobId:string;workDate:string;storeName:string;clientName:string;makerName:string;menuName:string;entryTime:string;workTime:string;cancelled:boolean}[]};
export type MailCandidate = { candidateId: string; revision: number; status: "ready" | "review" | "linked" | "cancelled"; creatable: boolean; linkedJobId: string | null;
  input: { workDate: string; clientName: string; storeName: string; makerName: string; menuName: string; entryTime: string; workTime: string };
  source: { partId: string; rowKey: string; unitIndex: number }; changeReview?: MailChangeReview; targetCandidates?: MailTargetCandidates; targetBinding?: {jobId:string} };
export type MailDetail = MailReceipt & { creationEnabled: boolean; producerReady: boolean; candidates: MailCandidate[] };
export type MailApi = { list(cursor?: string): Promise<unknown>; read(receiptId: string): Promise<unknown>; create(command: MailCommand): Promise<unknown>; previewTarget?(command: MailTargetRequest): Promise<unknown>; confirmTarget?(command: MailTargetConfirm): Promise<unknown>; holdTarget?(command: MailTargetRequest & {reviewVersion:string;kind:"change"|"cancel";confirmed:true}): Promise<unknown>; resolveTarget?(command: MailTargetConfirm): Promise<unknown>; confirm?(command: MailReviewCommand): Promise<unknown> };
const fail = () => new Error("受信候補の確認情報が不完全です。最新の内容を読み直してください。");
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(); return value as Record<string, unknown>; };
function receipt(value: unknown): MailReceipt {
  const row = object(value);
  if (!id(row.receiptId) || !revision(row.revision) || !["ready", "review", "cancelled"].includes(String(row.status)) ||
      (row.receivedAt !== null && (typeof row.receivedAt !== "string" || !Number.isFinite(Date.parse(row.receivedAt)))) ||
      !Number.isInteger(row.candidateCount) || Number(row.candidateCount) < 0 || Number(row.candidateCount) > 200 ||
      !Array.isArray(row.issues) || row.issues.length > 100 || row.issues.some(issue => typeof issue !== "string" || issue.length > 500)) throw fail();
  return row as unknown as MailReceipt;
}
export function mailList(value: unknown) {
  const row = object(value);
  if (row.ok !== true || !Array.isArray(row.items) || row.items.length > 25 || (row.nextCursor !== null && !id(row.nextCursor))) throw fail();
  const items = row.items.map(receipt);
  if (new Set(items.map(item => item.receiptId)).size !== items.length ||
      (row.nextCursor !== null && (items.length !== 25 || items.at(-1)?.receiptId !== row.nextCursor))) throw fail();
  return { items, nextCursor: row.nextCursor as string | null };
}
export function mailDetail(value: unknown, receiptId: string): MailDetail {
  const row = object(value), base = receipt(value);
  if (row.ok !== true || base.receiptId !== receiptId || typeof row.creationEnabled !== "boolean" || typeof row.producerReady !== "boolean" ||
      !Array.isArray(row.candidates) || row.candidates.length !== base.candidateCount) throw fail();
  const candidates = row.candidates.map(value => {
    const candidate = object(value), input = object(candidate.input), source = object(candidate.source);
    if (!id(candidate.candidateId) || !revision(candidate.revision) || !["ready", "review", "linked", "cancelled"].includes(String(candidate.status)) ||
        typeof candidate.creatable !== "boolean" || (candidate.linkedJobId !== null && !id(candidate.linkedJobId)) ||
        Object.values(input).some(value => typeof value !== "string") ||
        ["workDate", "clientName", "storeName", "makerName", "menuName", "entryTime", "workTime"].some(key => typeof input[key] !== "string") ||
        !id(source.partId) || typeof source.rowKey !== "string" || source.rowKey.length > 500 ||
        !Number.isInteger(source.unitIndex) || Number(source.unitIndex) < 0 || Number(source.unitIndex) > 99 ||
        (candidate.creatable && (base.status !== "ready" || candidate.status !== "ready" || !row.creationEnabled || !row.producerReady))) throw fail();
    if (candidate.targetBinding !== undefined && (!id(object(candidate.targetBinding).jobId) || candidate.creatable || candidate.linkedJobId !== null)) throw fail();
    if (candidate.targetCandidates !== undefined) {
      const targets = object(candidate.targetCandidates);
      if (base.status !== "review" || candidate.linkedJobId !== null || candidate.creatable || !["complete","limited","insufficient"].includes(String(targets.state)) || !Array.isArray(targets.items) || targets.items.length > 10 || (targets.state === "insufficient" && targets.items.length)) throw fail();
      const ids = targets.items.map(value => {
        const item = object(value);
        if (!id(item.jobId) || item.workDate !== input.workDate || typeof item.cancelled !== "boolean" || ["workDate","storeName","clientName","makerName","menuName","entryTime","workTime"].some(key => typeof item[key] !== "string" || (item[key] as string).length > 500)) throw fail();
        return item.jobId;
      });
      if (new Set(ids).size !== ids.length) throw fail();
    }
    if (candidate.changeReview !== undefined) {
      const review=object(candidate.changeReview);
      const validValues=(value:unknown)=>{const values=object(value);return typeof values.cancelled === "boolean" && ["workDate","clientName","storeName","makerName","menuName","entryTime","workTime","assignedStaffName","cancellationFinancialTreatment"].every(key=>typeof values[key]==="string");};
      if(!id(review.jobId)||review.jobId!==candidate.linkedJobId||typeof review.reviewVersion!=="string"||!/^[a-f0-9]{64}$/.test(review.reviewVersion)||
        typeof review.canConfirm!=="boolean"||typeof review.resolved!=="boolean"||(review.issue!==null&&typeof review.issue!=="string")||
        (review.canConfirm&&(review.resolved||review.issue!==null))||!validValues(review.current)||(review.proposed!==null&&!validValues(review.proposed)))throw fail();
    }
    return candidate as unknown as MailCandidate;
  });
  if (new Set(candidates.map(item => item.candidateId)).size !== candidates.length) throw fail();
  return { ...base, creationEnabled: row.creationEnabled, producerReady: row.producerReady, candidates };
}
export function mailCommand(value: unknown): MailCommand {
  const row = object(value), command = object(row.mailIntake);
  if (Object.keys(row).length !== 1 || Object.keys(command).sort().join(",") !== "candidateId,expectedReceiptRevision,expectedRevision,operationId,receiptId" ||
      !id(command.receiptId) || !id(command.candidateId) || !id(command.operationId) || !revision(command.expectedReceiptRevision) || !revision(command.expectedRevision)) throw fail();
  return { mailIntake: { receiptId: command.receiptId, candidateId: command.candidateId, expectedReceiptRevision: command.expectedReceiptRevision,
    expectedRevision: command.expectedRevision, operationId: command.operationId } };
}
export function mailCreationResult(value: unknown) {
  const row = object(value);
  if (row.resultIsCreationReceipt !== true || row.sourceReady !== false || typeof row.replayed !== "boolean" ||
      !Array.isArray(row.jobIds) || row.jobIds.length !== 1 || !id(row.jobIds[0])) throw fail();
  return { replayed: row.replayed, jobId: row.jobIds[0] };
}
export function mailOwner(companyId: string, uid: string) {
  if (!id(companyId) || !id(uid)) throw fail();
  return JSON.stringify([companyId, uid]);
}
const key = (owner: string) => "lkc.caseMailCreate.v1:" + owner;
export function loadMailAttempt(owner: string): MailCommand | null {
  try { const raw = localStorage.getItem(key(owner)); return raw === null ? null : mailCommand(JSON.parse(raw)); }
  catch { throw new Error("前回の案件作成記録を読めません。端末の保存設定を確認してください。"); }
}
async function lock<T>(owner: string, work: () => T): Promise<T> {
  if (!navigator.locks) throw new Error("このブラウザーでは案件作成の確認記録を保存できません。対応するブラウザーで開いてください。");
  return navigator.locks.request(key(owner), { mode: "exclusive", ifAvailable: true }, held => {
    if (!held) throw new Error("別の画面で確認中です。少し待ってから同じ操作を確認してください。");
    return work();
  });
}
export function reserveMailAttempt(owner: string, command: MailCommand, isCurrent: () => boolean) {
  return lock(owner, () => {
    if (!isCurrent()) return null;
    const existing = loadMailAttempt(owner); if (existing) return existing;
    const valid = mailCommand(command); localStorage.setItem(key(owner), JSON.stringify(valid));
    const saved = loadMailAttempt(owner);
    if (JSON.stringify(saved) !== JSON.stringify(valid)) throw fail();
    return saved;
  });
}
export function clearMailAttempt(owner: string, operationId: string, isCurrent: () => boolean) {
  return lock(owner, () => {
    if (!isCurrent()) return false;
    if (loadMailAttempt(owner)?.mailIntake.operationId === operationId) {
      localStorage.removeItem(key(owner)); if (loadMailAttempt(owner)) throw fail();
    }
    return true;
  });
}
export const mailStorageKey = key;
export function definiteMailRejection(error: unknown) {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ["failed-precondition", "permission-denied", "unauthenticated", "invalid-argument", "not-found"]
    .some(value => code === value || code === "functions/" + value);
}

export type MailTargetRequest = {receiptId:string;candidateId:string;jobId:string};
export type MailTargetConfirm = MailTargetRequest & {reviewVersion:string;note:string;confirmed:true};
export type MailTargetPreview = MailTargetRequest & {reviewVersion:string;state:"available"|"confirmed"|"held"|"resolved"|"stale"|"blocked";resolution?:{reviewVersion:string;canResolve:boolean;resolved:boolean;issue:string|null;originReviewRequired:boolean;kind:"change"|"cancel";proposed:Record<string,string>|null};issue:string|null;current:{workDate:string;storeName:string;clientName:string;makerName:string;menuName:string;entryTime:string;workTime:string;cancelled:boolean}};
export function mailTargetPreview(value:unknown,request:MailTargetRequest):MailTargetPreview {
  const row=object(value),current=object(row.current);
  if(row.ok!==true||row.receiptId!==request.receiptId||row.candidateId!==request.candidateId||row.jobId!==request.jobId||
    typeof row.reviewVersion!=="string"||!/^[a-f0-9]{64}$/.test(row.reviewVersion)||!["available","confirmed","held","resolved","stale","blocked"].includes(String(row.state))||
    (row.issue!==null&&typeof row.issue!=="string")||(["available","confirmed","held","resolved"].includes(String(row.state))&&row.issue!==null)||
    (["blocked","stale"].includes(String(row.state))&&!row.issue)||typeof current.cancelled!=="boolean"||
    ["workDate","storeName","clientName","makerName","menuName","entryTime","workTime"].some(key=>typeof current[key]!=="string"||(current[key] as string).length>500))throw fail();
  if(row.resolution!==undefined){
    const r=object(row.resolution);
    if(typeof r.reviewVersion!=="string"||!/^[a-f0-9]{64}$/.test(r.reviewVersion)||typeof r.canResolve!=="boolean"||typeof r.resolved!=="boolean"||
      typeof r.originReviewRequired!=="boolean"||!["change","cancel"].includes(String(r.kind))||(r.issue!==null&&typeof r.issue!=="string")||
      (r.canResolve&&(r.resolved||r.issue!==null||row.state!=="held"))||(r.resolved&&row.state!=="resolved"))throw fail();
    if(r.proposed!==null){const p=object(r.proposed);if(Object.keys(p).length!==7||["workDate","clientName","storeName","makerName","menuName","entryTime","workTime"].some(k=>typeof p[k]!=="string"||(p[k] as string).length>500))throw fail();}
  }
  if(row.state==="resolved"&&(row.resolution===undefined||!object(row.resolution).resolved))throw fail();
  return row as unknown as MailTargetPreview;
}
