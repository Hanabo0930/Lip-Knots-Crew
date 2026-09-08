import { createHash } from 'node:crypto';

export const ACCEPTANCE_PROJECT = 'lip-knots-crew-staging';
export const ACCEPTANCE_COMPANY = 'lkc-transfer-acceptance-20260908';
export const STAGING_DRIVE_PARENT = '0AOj1TGOInL72Uk9PVA';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function createSubmissionAcceptanceKit({ driveRootId = null } = {}) {
  if (driveRootId !== null && (typeof driveRootId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(driveRootId) || driveRootId === STAGING_DRIVE_PARENT)) {
    throw new Error('Dedicated child folder ID required; shared-drive root is prohibited');
  }
  const companyId = ACCEPTANCE_COMPANY;
  const jobId = `${companyId}-job`, staffId = `${companyId}-staff`, uid = `${companyId}-uid`;
  const submissionId = `${companyId}-submission`;
  const shared = { companyId, jobId, staffId, uid, type: 'report', purpose: 'initial', resubmissionRequestId: null };
  const files = [1, 2].map(index => {
    const fileId = `${companyId}-f${index}`, originalName = `fixture-${index}.txt`;
    const content = `LKC synthetic acceptance fixture ${index}\n`;
    return { fileId, originalName, content, contentType: 'text/plain', size: Buffer.byteLength(content),
      sha256: sha256(content), md5Base64: createHash('md5').update(content).digest('base64'),
      storagePath: `staging/${companyId}/${uid}/${submissionId}/${fileId}/${originalName}` };
  });
  const seeds = [
    { path: `companies/${companyId}/settings/drive`, data: { rootFolderId: driveRootId } },
    { path: `companies/${companyId}/sheetMappings/shift`, data: { enabled: false, spreadsheetId: '', columns: {}, operations: {} } },
    { path: `notificationSettings/${companyId}`, data: { enabled: false } },
    { path: `staffProfiles/${staffId}`, data: { companyId, displayName: 'LKC Synthetic Staff', active: false } },
    { path: `jobs/${jobId}`, data: { companyId, assignedStaffId: staffId, status: 'completed', dateKey: '2000-01-01', monthKey: '2000.1', clientName: 'LKC Synthetic Acceptance', storeName: 'LKC Synthetic Store' } },
    { path: `submissions/${submissionId}`, data: { ...shared, status: 'uploading', totalFiles: 2, completedFiles: 0 } },
    ...files.map(file => ({ path: `submissions/${submissionId}/files/${file.fileId}`, data: { ...shared, submissionId,
      status: 'waiting_upload', storagePath: file.storagePath, originalName: file.originalName, contentType: file.contentType, size: file.size } })),
  ].map(seed => ({ ...seed, precondition: { exists: false } }));
  const absencePaths = [...seeds.map(seed => seed.path), `companies/${companyId}`, `fileCounters/${jobId}_report`, ...files.map(file => `submissionFiles/${file.fileId}`)];
  const kit = {
    schemaVersion: 1, mode: 'local-review-only', project: ACCEPTANCE_PROJECT, region: 'asia-northeast1',
    companyId, jobId, staffId, uid, submissionId, seedDocuments: seeds, absencePaths, files,
    storageBucket: `${ACCEPTANCE_PROJECT}.firebasestorage.app`, storagePrefix: `staging/${companyId}/`,
    drive: { parentId: STAGING_DRIVE_PARENT, rootFolderId: driveRootId, childFolders: ['LKC Synthetic Acceptance', '2000.1'] },
    indirectWrites: { counterPath: `fileCounters/${jobId}_report`, queue: { collection: 'sheetSyncQueue', companyId, jobId, operation: 'submission.report', expectedNewCount: 1 }, storageDeletion: 'Function deletes each successfully transferred generation' },
    checks: { submittedFiles: 2, completedFiles: 2, driveFiles: 2, counterValue: 2, sheetQueues: 1, expectedSheetQueueStatus: 'blocked' },
    cloudExecutionAuthorized: false, includesCloudWriter: false,
  };
  return { ...kit, fingerprint: sha256(JSON.stringify(kit)) };
}

export function evaluateSubmissionAcceptanceEvidence(kit, evidence, now = Date.now()) {
  const expected = createSubmissionAcceptanceKit({ driveRootId: kit?.drive?.rootFolderId ?? null });
  if (JSON.stringify(kit) !== JSON.stringify(expected)) throw new Error('Kit changed; regenerate from source');
  const missing = [];
  if (!evidence || evidence.project !== ACCEPTANCE_PROJECT || evidence.kitFingerprint !== kit.fingerprint) missing.push('matching project and kit fingerprint');
  const readAt = Date.parse(evidence?.readAt ?? '');
  if (!Number.isFinite(now) || !Number.isFinite(readAt) || readAt > now || now - readAt > 10 * 60_000) missing.push('read evidence within 10 minutes');
  if (!kit.drive.rootFolderId) missing.push('dedicated Drive folder ID');
  if (evidence?.drive?.parentId !== STAGING_DRIVE_PARENT || evidence?.drive?.rootName !== kit.companyId || evidence?.drive?.rootFolderId !== kit.drive.rootFolderId || evidence?.drive?.runtimeCanAddChildren !== true || evidence?.drive?.runtimeIdentity !== '740154137290-compute@developer.gserviceaccount.com') missing.push('runtime Drive access for the dedicated folder');
  if (evidence?.storage?.bucket !== kit.storageBucket || evidence?.storage?.prefix !== kit.storagePrefix || evidence?.storage?.empty !== true) missing.push('empty dedicated Storage prefix');
  if (!Array.isArray(evidence?.documents) || !evidence.documents.every(item => item && typeof item.path === 'string' && typeof item.exists === 'boolean') || evidence.documents.length !== kit.absencePaths.length || new Set(evidence.documents.map(item => item.path)).size !== kit.absencePaths.length || kit.absencePaths.some(path => !evidence.documents.some(item => item.path === path && item.exists === false))) missing.push('all 12 dedicated document paths absent');
  for (const collection of ['notificationQueue', 'pushTokens', 'sheetSyncQueue', 'jobs', 'staffProfiles', 'submissions']) {
    if (evidence?.counts?.[collection]?.companyId !== kit.companyId || evidence?.counts?.[collection]?.count !== 0) missing.push(`${collection} company-scoped count is zero`);
  }
  return { mode: 'local-review-only', preflightChecksPassed: missing.length === 0, missing,
    cloudExecutionAuthorized: false, next: 'Obtain explicit data-operation approval and a reviewed execution procedure; this tool never applies cloud changes.' };
}

