import { createHash } from "node:crypto";
import type { drive_v3 } from "googleapis";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FOLDER_FIELDS = "id,name,parents,mimeType,trashed,appProperties";
const FOLDER_ID = /^[A-Za-z0-9_-]+$/;
const inFlight = new Map<string, Promise<string>>();
type FolderBinding = { parentId: string; name: string; folderId: string; allocated: boolean };

function unavailableFolder() {
  return new HttpsError("failed-precondition", "提出先のDriveフォルダを一意に確認できません。提出履歴を確認してください。");
}

function isBoundFolder(file: drive_v3.Schema$File, parentId: string, name: string): boolean {
  return FOLDER_ID.test(file.id ?? "") && file.name === name && file.mimeType === FOLDER_MIME &&
    file.trashed === false && file.parents?.length === 1 && file.parents[0] === parentId;
}

function notFound(error: unknown): boolean {
  const failure = error as { response?: { status?: number }; code?: string | number };
  return Number(failure?.response?.status ?? failure?.code) === 404;
}

async function resolveFolder(drive: drive_v3.Drive, key: string, parentId: string, name: string): Promise<string> {
  const ref = db.collection("driveSubmissionFolders").doc(key);
  let saved = (await ref.get()).data();
  if (!saved) {
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const { data } = await drive.files.list({
      q: `'${parentId}' in parents and name='${escaped}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: `nextPageToken,incompleteSearch,files(${FOLDER_FIELDS})`,
      pageSize: 2, spaces: "drive", supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const found = data.files ?? [];
    if (data.incompleteSearch || data.nextPageToken || found.length > 1 ||
      (found[0] && !isBoundFolder(found[0], parentId, name))) throw unavailableFolder();
    const existingId = found[0]?.id;
    const folderId = existingId ?? (await drive.files.generateIds({ count: 1, space: "drive", type: "files" })).data.ids?.[0];
    if (!folderId || !FOLDER_ID.test(folderId)) throw unavailableFolder();
    const proposed: FolderBinding = { parentId, name, folderId, allocated: !existingId };
    // Drive calls stay outside the transaction. Every worker uses the binding that commits first.
    saved = await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.exists) return current.data()!;
      tx.create(ref, proposed);
      return proposed;
    });
  }
  const { folderId, allocated } = saved;
  if (saved.parentId !== parentId || saved.name !== name ||
    typeof allocated !== "boolean" || typeof folderId !== "string" || !FOLDER_ID.test(folderId)) throw unavailableFolder();

  const read = () => drive.files.get({ fileId: folderId, fields: FOLDER_FIELDS, supportsAllDrives: true });
  let response;
  try {
    response = await read();
  } catch (error) {
    if (!allocated || !notFound(error)) throw error;
    try {
      response = await drive.files.create({
        requestBody: { id: folderId, name, parents: [parentId], mimeType: FOLDER_MIME, appProperties: { lkcFolder: key } },
        fields: FOLDER_FIELDS, supportsAllDrives: true,
      });
    } catch (createError) {
      // A conflict or a lost response can still mean this exact ID was created.
      try { response = await read(); }
      catch (readError) { throw notFound(readError) ? createError : readError; }
    }
  }
  if (response.data.id !== folderId || !isBoundFolder(response.data, parentId, name) ||
    (allocated && response.data.appProperties?.lkcFolder !== key)) throw unavailableFolder();
  return folderId;
}

export async function ensureSubmissionFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string> {
  // Drive resolves the literal "root" alias to its actual ID in the returned parents field.
  if (parentId === "root") {
    const response = await drive.files.get({ fileId: parentId, fields: "id", supportsAllDrives: true });
    parentId = response.data.id ?? "";
  }
  if (!FOLDER_ID.test(parentId) || !name) throw unavailableFolder();
  const key = createHash("sha256").update(JSON.stringify([parentId, name])).digest("hex");
  const pending = inFlight.get(key);
  if (pending) return pending;
  const resolution = resolveFolder(drive, key, parentId, name).finally(() => inFlight.delete(key));
  inFlight.set(key, resolution);
  return resolution;
}

