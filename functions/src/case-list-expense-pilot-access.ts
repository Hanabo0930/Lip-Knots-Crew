import { HttpsError } from "firebase-functions/v2/https";
import type { drive_v3 } from "googleapis";

export type PilotDriveReader = Pick<drive_v3.Drive, "about" | "files" | "permissions">;
export type ExpensePilotBook = Readonly<{
  spreadsheetId: string;
  ownerPermissionId: string;
  readerPermissionIds: readonly string[];
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;
const API = { retry: false, timeout: 5_000 };
const MAX_PERMISSION_PAGES = 10;
const FILE_FIELDS = "id,mimeType,trashed,driveId,parents,ownedByMe,owners(permissionId,me),version,capabilities(canEdit,canModifyContent)";

function refused(reason: string) {
  return new HttpsError("failed-precondition", "試験用の月別表と編集権限を確認できないため、書込みを停止しました。", { reason });
}

/**
 * Read-only prerequisite for the one-book pilot. File ACLs cannot prevent the
 * owner itself from editing, so the actual pilot also needs a dedicated owner
 * credential controlled exclusively by the gateway.
 */
export function createExpensePilotBookAccess(policy: ExpensePilotBook, drive: PilotDriveReader, mode: "preflight" | "exercise" = "exercise") {
  const { spreadsheetId, ownerPermissionId } = policy;
  if (!Array.isArray(policy.readerPermissionIds)) throw refused("expense_pilot_configuration");
  const readers = new Set(policy.readerPermissionIds);
  if (!IDENTIFIER.test(spreadsheetId) || !IDENTIFIER.test(ownerPermissionId) ||
      readers.size !== policy.readerPermissionIds.length || readers.has(ownerPermissionId) ||
      [...readers].some(id => !IDENTIFIER.test(id))) throw refused("expense_pilot_configuration");

  async function readFileVersion(rootId: string): Promise<string> {
    const { data } = await drive.files.get({ fileId: spreadsheetId, fields: FILE_FIELDS, supportsAllDrives: true }, API);
    const owner = data.owners?.[0];
    if (data.id !== spreadsheetId || data.mimeType !== "application/vnd.google-apps.spreadsheet" ||
        data.trashed !== false || data.driveId || data.ownedByMe !== true ||
        data.parents?.length !== 1 || data.parents[0] !== rootId ||
        data.owners?.length !== 1 || owner?.permissionId !== ownerPermissionId || owner.me !== true ||
        (mode === "exercise" && (data.capabilities?.canEdit !== true || data.capabilities.canModifyContent !== true)) ||
        typeof data.version !== "string" || !/^[1-9][0-9]*$/.test(data.version)) {
      throw refused("expense_pilot_book_scope");
    }
    return data.version;
  }

  async function checkPermissions(): Promise<void> {
    let pageToken: string | undefined;
    const seen = new Set<string>(), tokens = new Set<string>();
    for (let page = 0; page < MAX_PERMISSION_PAGES; page++) {
      const { data } = await drive.permissions.list({
        fileId: spreadsheetId,
        fields: "nextPageToken,permissions(id,type,role,view,deleted,pendingOwner,permissionDetails(inherited,inheritedFrom))",
        includePermissionsForView: "published",
        supportsAllDrives: true, useDomainAdminAccess: false, pageSize: 100, pageToken,
      }, API);
      for (const item of data.permissions ?? []) {
        const { id, type, role, view, deleted, pendingOwner, permissionDetails } = item;
        if (!id || seen.has(id) || type !== "user" || view || deleted === true || pendingOwner === true ||
            permissionDetails?.some(detail => detail.inherited === true || detail.inheritedFrom) ||
            (id === ownerPermissionId ? role !== "owner" : role !== "reader" || !readers.has(id))) {
          throw refused("expense_pilot_book_permissions");
        }
        seen.add(id);
      }
      const next = data.nextPageToken;
      if (next == null) {
        if (!seen.has(ownerPermissionId) || seen.size !== readers.size + 1) throw refused("expense_pilot_book_permissions");
        return;
      }
      if (!next || tokens.has(next)) throw refused("expense_pilot_permissions_incomplete");
      tokens.add(next);
      pageToken = next;
    }
    throw refused("expense_pilot_permissions_incomplete");
  }

  return async (): Promise<string> => {
    try {
      const [{ data: identity }, { data: root }] = await Promise.all([
        drive.about.get({ fields: "user(permissionId,me)" }, API),
        drive.files.get({ fileId: "root", fields: "id,mimeType" }, API),
      ]);
      if (identity.user?.permissionId !== ownerPermissionId || identity.user.me !== true ||
          !root.id || !IDENTIFIER.test(root.id) || root.mimeType !== "application/vnd.google-apps.folder") {
        throw refused("expense_pilot_owner_identity");
      }
      const version = await readFileVersion(root.id);
      await checkPermissions();
      if (await readFileVersion(root.id) !== version) throw refused("expense_pilot_book_changed");
      return version;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw refused("expense_pilot_metadata_unavailable");
    }
  };
}
