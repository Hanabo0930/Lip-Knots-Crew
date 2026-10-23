// Local candidate: every App writer enters this adapter. Raw stores are implementation details.
// New-generation storage only. Its writers share this protocol; legacy storage is untouched.
import * as drafts from "./draft-store";
import * as attempts from "./submission-attempt-store";
import * as bindings from "./submitted-binding-store";
import * as markers from "./submitted-marker-store";
import {submissionFileContentType} from "./submission-file-content-type";
import {assertSubmissionContext, submissionContextCurrent, withSubmissionContext, type SubmissionContextLease} from "./submission-context-lock";
import type {SubmissionAttempt} from "./submission-attempt-store";
import type {SubmittedCleanupState} from "./submitted-binding-store";
export {withSubmissionContext};
export type {SubmissionContextLease};
type Identity = Pick<SubmissionAttempt, "clientRequestId" | "storageKey">;
const always = () => true;
const uncertain = () => new Error("端末の提出記録を照合できません。再送せず提出履歴を確認してください。");
const current = (key: string, lease: SubmissionContextLease, check: () => boolean = always) => () => check() && submissionContextCurrent(key, lease);
function readSubmittedMarker(key: string) {
  const marker = localStorage.getItem(markers.receiptKey(key));
  if (marker !== null && marker !== "1") throw uncertain();
  return markers.getSubmittedDraftReceipt(key);
}

// A busy reader may retry this snapshot explicitly. It never clears a receipt, marker or draft.
export async function readSubmissionDraft(key: string, isCurrent: () => boolean): Promise<{files: File[]; cleanup: SubmittedCleanupState | null}> {
  return withSubmissionContext(key, isCurrent, async lease => {
    const bound = await bindings.hasSubmittedBindings(key);
    assertSubmissionContext(key, lease);
    const receipt = readSubmittedMarker(key);
    if (bound || receipt) return {files: [], cleanup: {key, durable: bound || Boolean(receipt?.durable), recovered: true}};
    const files = await drafts.loadDraft(key);
    assertSubmissionContext(key, lease);
    return {files, cleanup: null};
  });
}

export const saveDraft = (key: string, files: File[], isCurrent = always, held?: SubmissionContextLease) =>
  withSubmissionContext(key, isCurrent, async lease => {
    const check = current(key, lease, isCurrent);
    await attempts.assertDraftMatchesPendingAttempt(key, files, files.map(submissionFileContentType), check);
    try { await drafts.saveDraft(key, files, check); }
    catch { throw new Error("選択ファイルを端末へ保存できません。この画面に保持しています。画面を閉じず、保存設定を確認して再試行してください。"); }
  }, held);
export const loadDraft = (key: string, held?: SubmissionContextLease) =>
  withSubmissionContext(key, always, () => drafts.loadDraft(key), held);
export const hasStoredDraft = (key: string, held?: SubmissionContextLease) =>
  withSubmissionContext(key, always, () => drafts.hasStoredDraft(key), held);
export const hasSubmittedBindings = (key: string, held?: SubmissionContextLease) =>
  withSubmissionContext(key, always, () => bindings.hasSubmittedBindings(key), held);
export const markDraftSubmitted = (key: string, isCurrent = always, held?: SubmissionContextLease) =>
  withSubmissionContext(key, isCurrent, lease => {assertSubmissionContext(key, lease); return markers.markDraftSubmitted(key);}, held);
export const saveSubmittedBinding = (key: string, attempt: Identity, isCurrent: () => boolean, held?: SubmissionContextLease) =>
  withSubmissionContext(key, isCurrent, lease => bindings.saveSubmittedBinding(key, attempt, current(key, lease, isCurrent)), held);

export async function prepareSubmissionAttempt(key: string, files: File[], types: string[], isCurrent = always, revision?: number, held?: SubmissionContextLease, dateKey?: string) {
  return withSubmissionContext(key, isCurrent, async lease => {
    if (markers.getSubmittedDraftReceipt(key) || await bindings.hasSubmittedBindings(key)) throw uncertain();
    return attempts.prepareSubmissionAttempt(key, files, types, current(key, lease, isCurrent), revision, dateKey);
  }, held);
}
export async function clearSubmissionAttempt(attempt: Identity, isCurrent = always, lease?: SubmissionContextLease): Promise<boolean> {
  if (!lease) return false;
  assertSubmissionContext(lease.key, lease);
  return attempts.clearSubmissionAttempt(attempt, current(lease.key, lease, isCurrent));
}

export function submissionRequest(attempt: SubmissionAttempt,
  target: {jobId: string; type: string; purpose: string; resubmissionRequestId: string | null}, files: File[]) {
  return {...target, resubmissionRequestId: target.resubmissionRequestId || undefined, clientRequestId: attempt.clientRequestId,
    ...(attempt.expectedRevision !== undefined ? {expectedRevision: attempt.expectedRevision} : {}),
    ...(attempt.expectedDateKey !== undefined ? {expectedDateKey: attempt.expectedDateKey} : {}),
    files: files.map((file, index) => ({originalName: file.name, contentType: submissionFileContentType(file), size: file.size, contentSha256: attempt.contentHashes[index]}))};
}

export async function resetUnacceptedSubmission(
  error: unknown, attempt: SubmissionAttempt,
  target: {jobId: string; type: string; purpose: string; resubmissionRequestId: string | null},
  isCurrent: () => boolean, lease: SubmissionContextLease,
): Promise<boolean> {
  const details = (error as {details?: Record<string, unknown>} | null)?.details;
  if (!isCurrent() || !details || attempt.expectedDateKey === undefined || attempt.expectedRevision === undefined ||
      details.reason !== "submission_context_changed" || details.accepted !== false ||
      details.clientRequestId !== attempt.clientRequestId || details.expectedDateKey !== attempt.expectedDateKey ||
      details.expectedRevision !== attempt.expectedRevision || details.jobId !== target.jobId || details.type !== target.type ||
      details.purpose !== target.purpose || details.resubmissionRequestId !== target.resubmissionRequestId) return false;
  return clearSubmissionAttempt(attempt, isCurrent, lease);
}

async function verifyStoredDraft(key: string, attempt: Identity, isCurrent: () => boolean): Promise<void> {
  readSubmittedMarker(key);
  if (!await bindings.canClearBoundDraft(key, attempt) || !isCurrent()) throw uncertain();
  const files = await drafts.readStoredDraftFiles(key);
  if (!isCurrent()) throw uncertain();
  // The ID comes from a completed-upload binding, never from these file hashes.
  // Hashes only reject a saved A that differs from the actual uploaded B.
  if (files.length && (await attempts.fingerprintSubmissionFiles(key, files, files.map(submissionFileContentType), isCurrent)).storageKey !== attempt.storageKey) throw uncertain();
  if (!isCurrent()) throw uncertain();
}
export async function clearDraft(key: string, attempt?: Identity, isCurrent = always, held?: SubmissionContextLease): Promise<void> {
  return withSubmissionContext(key, isCurrent, async lease => {
    const check = current(key, lease, isCurrent);
    if (attempt) await verifyStoredDraft(key, attempt, check);
    else if (markers.getSubmittedDraftReceipt(key) || await bindings.hasSubmittedBindings(key) || await attempts.hasPendingSubmissionAttempt(key)) throw uncertain();
    assertSubmissionContext(key, lease);
    await drafts.clearDraft(key, attempt, check);
  }, held);
}
export const confirmDraftCleanupComplete = (key: string, isCurrent: () => boolean, held?: SubmissionContextLease) =>
  withSubmissionContext(key, isCurrent, lease => drafts.confirmDraftCleanupComplete(key, current(key, lease, isCurrent)), held);
export const finishSubmittedBindings = (key: string, isCurrent: () => boolean, _read: () => Promise<boolean>, attempt?: Identity, held?: SubmissionContextLease) =>
  withSubmissionContext(key, isCurrent, lease => bindings.finishSubmittedBindings(key, current(key, lease, isCurrent), () => drafts.hasStoredDraft(key), attempt), held);

export async function retrySubmittedCleanup(
  initial: SubmittedCleanupState, isCurrent: () => boolean,
  setState: (update: (value: SubmittedCleanupState | null) => SubmittedCleanupState | null) => void,
  _ports?: unknown,
): Promise<void> {
  await withSubmissionContext(initial.key, isCurrent, async lease => {
    let target = initial;
    const check = current(initial.key, lease, isCurrent);
    const advance = (next: SubmittedCleanupState) => {const previous = target;setState(value => value === previous ? next : value);target = next;};
    try {
      if (!target.bindingSaved && target.attempt) {
        if (!await saveSubmittedBinding(target.key, target.attempt, check, lease)) throw uncertain();
        advance({...target, bindingSaved:true});
      }
      const identity = await bindings.readSubmittedBindingIdentity(target.key);
      if (!identity || !check() || (target.attempt && (target.attempt.clientRequestId !== identity.clientRequestId || target.attempt.storageKey !== identity.storageKey))) throw uncertain();
      await verifyStoredDraft(target.key, identity, check);
      if (!await clearSubmissionAttempt(identity, check, lease) || localStorage.getItem(identity.storageKey) !== null) throw uncertain();
      await clearDraft(target.key, identity, check, lease);
      advance({...target, draftCleared:true, recovered:true});
      if (!await finishSubmittedBindings(target.key, check, () => drafts.hasStoredDraft(target.key), identity, lease) ||
          !await confirmDraftCleanupComplete(target.key, check, lease) || !check()) throw uncertain();
      setState(value => value === target ? null : value);
    } catch (error) {
      if (check()) advance({...target, recovered:true, unverified:true});
      throw error;
    }
  });
}
