'use strict';

const assert = require('node:assert/strict');
const OWNER = 'SYNTHETIC_OWNER_PERMISSION';
const READER = 'SYNTHETIC_VIEWER_PERMISSION';
const ROOT = 'SYNTHETIC_OWNER_ROOT';
const owner = { id: OWNER, type: 'user', role: 'owner' };
const reader = { id: READER, type: 'user', role: 'reader' };

function pilotDriveFixture(spreadsheetId) {
  const policy = { spreadsheetId, ownerPermissionId: OWNER, readerPermissionIds: [READER] };
  const state = {
    user: { permissionId: OWNER, me: true },
    root: { id: ROOT, mimeType: 'application/vnd.google-apps.folder' },
    file: { id: spreadsheetId, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, ownedByMe: true,
      parents: [ROOT], owners: [{ permissionId: OWNER, me: true }], version: '1',
      capabilities: { canEdit: true, canModifyContent: true } },
    pages: new Map([[undefined, { permissions: [owner], nextPageToken: 'second' }], ['second', { permissions: [reader] }]]),
    reads: [],
    onList: null,
  };
  const drive = {
    about: { async get(request) {
      assert.equal(request.fields, 'user(permissionId,me)');
      state.reads.push({ name: 'about' });
      return { data: { user: { ...state.user } } };
    } },
    files: { async get(request) {
      state.reads.push({ name: 'files', id: request.fileId });
      if (request.fileId === 'root') return { data: { ...state.root } };
      assert.equal(request.fileId, spreadsheetId);
      assert.equal(request.supportsAllDrives, true);
      assert.match(request.fields, /owners\(permissionId,me\)/);
      return { data: JSON.parse(JSON.stringify(state.file)) };
    } },
    permissions: { async list(request) {
      assert.equal(request.fileId, spreadsheetId);
      assert.equal(request.supportsAllDrives, true);
      assert.equal(request.useDomainAdminAccess, false);
      assert.equal(request.includePermissionsForView, 'published');
      state.reads.push({ name: 'permissions', token: request.pageToken });
      await state.onList?.(request.pageToken);
      const found = state.pages.get(request.pageToken);
      if (!found) throw Error('SYNTHETIC_ACL_PAGE_MISSING');
      return { data: JSON.parse(JSON.stringify(found)) };
    } },
  };
  return { policy, state, drive };
}

module.exports = { pilotDriveFixture };
