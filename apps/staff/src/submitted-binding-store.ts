import {isSubmissionAttemptKey, submissionAttemptPrefix, submittedBindingPrefix, submittedMarkerKey} from "./submission-namespace";
import {isStoredSubmissionAttempt} from "./submission-attempt-store";
import type { SubmissionAttempt } from "./submission-attempt-store";

type ReceiptIdentity = Pick<SubmissionAttempt, "clientRequestId" | "storageKey">;
type SubmittedBinding = {
  version: 2;
  clientRequestId: string;
  receiptStorageKey: string;
  draftScopeSha256: string;
};
type Entry = { key: string; raw: string; binding: SubmittedBinding };
const PREFIX = submittedBindingPrefix;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const markerKey = submittedMarkerKey;
const uncertain = () => new Error("端末の提出記録を確認できません。再送せず、提出履歴と端末の保存設定を確認してください。");

async function scopeFor(key: string): Promise<string> {
  if (!key || !crypto.subtle) throw uncertain();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))), value => value.toString(16).padStart(2, "0")).join("");
}
function keysFor(scope: string): string[] {
  const prefix = PREFIX + scope + ":";
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys.sort();
}
function entriesFor(scope: string): Entry[] {
  const keys = keysFor(scope);
  const entries = keys.map(key => {
    const raw = localStorage.getItem(key);
    if (raw === null) throw uncertain();
    const value = JSON.parse(raw) as SubmittedBinding;
    if (!value || Object.keys(value).sort().join(",") !== "clientRequestId,draftScopeSha256,receiptStorageKey,version" ||
      value.version !== 2 || typeof value.clientRequestId !== "string" || !UUID.test(value.clientRequestId) ||
      typeof value.receiptStorageKey !== "string" || (!isSubmissionAttemptKey(value.receiptStorageKey) || !value.receiptStorageKey.startsWith(submissionAttemptPrefix + scope + ":")) ||
      value.draftScopeSha256 !== scope || key !== PREFIX + scope + ":" + value.clientRequestId) throw uncertain();
    return { key, raw, binding: value };
  });
  if (JSON.stringify(keysFor(scope)) !== JSON.stringify(keys) || entries.some(entry => localStorage.getItem(entry.key) !== entry.raw)) throw uncertain();
  return entries;
}
function receiptMatchesOrAbsent(binding: SubmittedBinding): boolean {
  const raw = localStorage.getItem(binding.receiptStorageKey);
  if (raw === null) return true;
  const saved = JSON.parse(raw);
  return isStoredSubmissionAttempt(saved) && saved.clientRequestId === binding.clientRequestId;
}
export async function hasSubmittedBindings(key: string): Promise<boolean> {
  return entriesFor(await scopeFor(key)).length > 0;
}

export async function readSubmittedBindingIdentity(key: string): Promise<ReceiptIdentity | null> {
  const entries = entriesFor(await scopeFor(key));
  if (entries.length !== 1 || !receiptMatchesOrAbsent(entries[0].binding)) return null;
  return {clientRequestId: entries[0].binding.clientRequestId, storageKey: entries[0].binding.receiptStorageKey};
}

// Called only with the current completed upload's identity, never with saved draft files.
export async function saveSubmittedBinding(key: string, attempt: ReceiptIdentity, isCurrent: () => boolean): Promise<boolean> {
  try {
    const scope = await scopeFor(key);
    if (!UUID.test(attempt.clientRequestId) || (!isSubmissionAttemptKey(attempt.storageKey) || !attempt.storageKey.startsWith(submissionAttemptPrefix + scope + ":")) || !navigator.locks) return false;
    const binding: SubmittedBinding = { version: 2, clientRequestId: attempt.clientRequestId, receiptStorageKey: attempt.storageKey, draftScopeSha256: scope };
    const storageKey = PREFIX + scope + ":" + binding.clientRequestId;
    const raw = JSON.stringify(binding);
    return await navigator.locks.request(PREFIX + scope, { mode: "exclusive" }, () => {
      if (!isCurrent() || localStorage.getItem(markerKey(key)) !== "1" || !receiptMatchesOrAbsent(binding)) return false;
      entriesFor(scope); // Invalid/partial records are not overwritten or silently ignored.
      const previous = localStorage.getItem(storageKey);
      if (previous !== null && previous !== raw) return false;
      localStorage.setItem(storageKey, raw);
      return localStorage.getItem(storageKey) === raw && localStorage.getItem(markerKey(key)) === "1" && isCurrent();
    });
  } catch { return false; }
}

// Only the existing current-session cleanup may pass its in-memory identity.
// A recovered binding alone never authorizes clearing the shared draft or legacy marker.
export async function canClearBoundDraft(key: string, attempt?: ReceiptIdentity): Promise<boolean> {
  const entries = entriesFor(await scopeFor(key));
  if (!attempt) return entries.length === 0;
  return entries.length === 1 && entries[0].binding.clientRequestId === attempt.clientRequestId &&
    entries[0].binding.receiptStorageKey === attempt.storageKey && receiptMatchesOrAbsent(entries[0].binding);
}

// No legacy-marker or IndexedDB writes. Missing evidence is not successful cleanup.
export async function finishSubmittedBindings(
  key: string, isCurrent: () => boolean, hasStoredDraft: () => Promise<boolean>,
  requiredAttempt?: ReceiptIdentity,
): Promise<boolean> {
  try {
    const scope = await scopeFor(key);
    if (!navigator.locks) return false;
    return await navigator.locks.request(PREFIX + scope, { mode: "exclusive" }, async () => {
      const original = entriesFor(scope);
      if (!original.length) return false;
      if (requiredAttempt && !original.some(entry => entry.binding.clientRequestId === requiredAttempt.clientRequestId &&
        entry.binding.receiptStorageKey === requiredAttempt.storageKey)) return false;
      let remaining = original;
      const unchanged = () => {
        if (!isCurrent() || localStorage.getItem(markerKey(key)) !== null) return false;
        const current = entriesFor(scope);
        return current.length === remaining.length && current.every((entry, index) => entry.key === remaining[index].key && entry.raw === remaining[index].raw);
      };
      const sharedStateAbsent = async () => unchanged() && !await hasStoredDraft() && unchanged();
      if (!await sharedStateAbsent() || !original.every(entry => receiptMatchesOrAbsent(entry.binding))) return false;
      const { clearSubmissionAttempt } = await import("./submission-attempt-store");
      for (const entry of original) {
        if (!await sharedStateAbsent()) return false;
        const attempt = { clientRequestId: entry.binding.clientRequestId, storageKey: entry.binding.receiptStorageKey };
        const cleared = await clearSubmissionAttempt(attempt, () => unchanged() && receiptMatchesOrAbsent(entry.binding));
        if (!cleared || !unchanged() || localStorage.getItem(attempt.storageKey) !== null) return false;
      }
      if (!await sharedStateAbsent()) return false;
      for (const entry of original) {
        if (!unchanged() || original.some(item => localStorage.getItem(item.binding.receiptStorageKey) !== null)) return false;
        localStorage.removeItem(entry.key);
        if (localStorage.getItem(entry.key) !== null) return false;
        remaining = remaining.filter(item => item.key !== entry.key);
      }
      return await sharedStateAbsent();
    });
  } catch { return false; }
}

export type SubmittedCleanupState = {
  key: string; durable: boolean; attempt?: SubmissionAttempt; draftCleared?: boolean;
  attemptCleared?: boolean; unverified?: boolean; bindingSaved?: boolean; recovered?: boolean; uncertain?: boolean;
  busy?: boolean; // Transient UI read contention only; never persisted as submission evidence.
};
type CleanupPorts = {
  saveSubmittedBinding: typeof saveSubmittedBinding;
  finishSubmittedBindings: typeof finishSubmittedBindings;
  hasStoredDraft: (key: string) => Promise<boolean>;
  confirmDraftCleanupComplete: (key: string, isCurrent: () => boolean) => Promise<boolean>;
};

// Kept with the on-demand verifier so startup does not include cleanup orchestration.
// The ports are the existing stores; this function never initiates upload or an API call.
export async function retrySubmittedCleanup(
  initial: SubmittedCleanupState, isCurrent: () => boolean,
  setDraftCleanup: (update: (current: SubmittedCleanupState | null) => SubmittedCleanupState | null) => void,
  ports: CleanupPorts,
): Promise<void> {
  if (!isCurrent()) return;
  let target = initial;
  const {saveSubmittedBinding,finishSubmittedBindings,hasStoredDraft,confirmDraftCleanupComplete}=ports;
    const advance=(next:typeof target)=>{
      const previous=target;
      setDraftCleanup(current=>current===previous?next:current);
      target=next;
    };
  try{
        if(!target.bindingSaved&&target.attempt){
          // This identity still proves which upload completed, but not who owns a later shared marker.
          // Save only its auxiliary record; never recreate or remove a shared marker on retry.
          const saved=await saveSubmittedBinding(target.key,target.attempt,isCurrent);
          if(!isCurrent())return;
          if(!saved){advance({...target,recovered:true,unverified:true});return;}
          advance({...target,durable:true,bindingSaved:true});
        }
        advance({...target,recovered:true});
        // A manual retry never owns shared state, even when this screen remembers an exact old ID.
        const finished=await finishSubmittedBindings(target.key,isCurrent,()=>hasStoredDraft(target.key),target.attempt);
        if(!isCurrent())return;
        if(!finished||!await confirmDraftCleanupComplete(target.key,isCurrent)){
          advance({...target,unverified:true});return;
        }
        if(isCurrent())setDraftCleanup(current=>current===target?null:current);
  }catch(error){
    if(isCurrent())setDraftCleanup(current=>current===target?{...current,unverified:true}:current);
    throw error;
  }
}
