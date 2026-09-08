import { createHash } from 'node:crypto';
import { createSubmissionAcceptanceKit } from './submission-acceptance-kit.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
const exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// 入力は読取結果を正規化したローカルJSON。署名済み証跡や実クラウド受入を装わない。
export function verifySubmissionAcceptanceResult(kit, result, now = Date.now()) {
  const expected = createSubmissionAcceptanceKit({ driveRootId: kit?.drive?.rootFolderId ?? null });
  if (!exact(kit, expected)) throw new Error('Kit changed; regenerate from source');
  const issues = [];
  const check = (condition, code) => { if (!condition) issues.push(code); };
  const startedAt = timestamp(result?.startedAt), readAt = timestamp(result?.readAt);
  check(result?.project === kit.project && result?.kitFingerprint === kit.fingerprint, 'result_identity');
  check(Number.isFinite(now) && Number.isFinite(startedAt) && Number.isFinite(readAt) && startedAt <= readAt && readAt <= now && now - readAt <= 600_000, 'result_time');
  check(typeof kit.drive.rootFolderId === 'string', 'dedicated_drive_root');
  const documents = Array.isArray(result?.documents) ? result.documents : [];
  check(documents.every(item => item && typeof item.path === 'string' && item.data && typeof item.data === 'object') && new Set(documents.map(item => item?.path)).size === documents.length, 'document_shape');
  const document = path => documents.find(item => item?.path === path)?.data;
  const expectedPaths = kit.seedDocuments.map(item => item.path).concat(kit.indirectWrites.counterPath);
  const queues = documents.filter(item => typeof item?.path === 'string' && /^sheetSyncQueue\/[^/]+$/.test(item.path));
  check(documents.length === expectedPaths.length + 1 && expectedPaths.every(path => documents.some(item => item?.path === path)) && queues.length === 1, 'document_scope');
  for (const seed of kit.seedDocuments) {
    const current = document(seed.path);
    // 完了時に変更される値だけを比較対象から外す。所属・隔離設定は照合する。
    const mutable = seed.path === `submissions/${kit.submissionId}` ? ['status', 'completedFiles'] : seed.path.includes('/files/') ? ['status'] : [];
    check(current && Object.entries(seed.data).every(([key, value]) => mutable.includes(key) || exact(current[key], value)), `seed_identity:${seed.path}`);
  }
  const submission = document(`submissions/${kit.submissionId}`);
  check(submission?.status === 'completed' && submission?.completedFiles === 2 && submission?.totalFiles === 2 && submission?.jobStatusApplied === true && !submission?.errorMessage && !submission?.failedFileId, 'submission_completed');
  const job = document(`jobs/${kit.jobId}`), report = job?.submissionStatus?.report;
  check(job?.sheetRef === undefined && report?.completed === true && report?.lipKnotsSubmitted === true && report?.lateFirstSubmission === true, 'job_completed_without_sheet_reference');
  check(document(kit.indirectWrites.counterPath)?.value === 2, 'counter_exactly_two');
  const folders = Array.isArray(result?.drive?.folders) ? result.drive.folders : [];
  const root = folders.find(item => item?.id === kit.drive.rootFolderId);
  const client = folders.find(item => item?.name === kit.drive.childFolders[0]);
  const month = folders.find(item => item?.name === kit.drive.childFolders[1]);
  check(folders.length === 3 && folders.every(item => typeof item?.id === 'string' && item.id.length > 0 && item.mimeType === 'application/vnd.google-apps.folder' && item.trashed === false) && new Set(folders.map(item => item?.id)).size === 3 && root?.name === kit.companyId && exact(root?.parents, [kit.drive.parentId]) && exact(client?.parents, [root?.id]) && exact(month?.parents, [client?.id]), 'dedicated_folder_hierarchy');
  const driveFiles = Array.isArray(result?.drive?.files) ? result.drive.files : [];
  const sources = Array.isArray(result?.storage) ? result.storage : [];
  check(driveFiles.length === 2 && new Set(driveFiles.map(item => item?.id)).size === 2, 'drive_file_count');
  check(sources.length === 2 && new Set(sources.map(item => item?.path)).size === 2, 'storage_source_count');
  const sequences = [], completionTimes = [];
  for (const fixture of kit.files) {
    const file = document(`submissions/${kit.submissionId}/files/${fixture.fileId}`);
    const source = sources.find(item => item?.path === fixture.storagePath);
    const plan = file?.driveTransferPlan;
    const drive = driveFiles.find(item => typeof item?.id === 'string' && item.id === file?.driveFileId);
    const sourceValid = source?.bucket === kit.storageBucket && typeof source?.generation === 'string' && /^[1-9]\d*$/.test(source.generation) && source?.size === String(fixture.size) && source?.contentType === fixture.contentType && source?.md5Base64 === fixture.md5Base64 && source?.exists === false;
    check(sourceValid, `source_deleted:${fixture.fileId}`);
    const sourceKey = sourceValid ? hash({ bucket: source.bucket, path: source.path, generation: source.generation, size: source.size, contentType: source.contentType, md5: Buffer.from(source.md5Base64, 'base64').toString('hex') }) : null;
    check(file?.status === 'completed' && file?.completionCounted === true && !file?.errorMessage, `file_completed:${fixture.fileId}`);
    check(typeof plan?.id === 'string' && plan.id.length > 0 && plan.id === file?.driveFileId && typeof plan?.name === 'string' && plan.name.length > 0 && plan.name === file?.driveName && plan.sequence === file?.sequence && Number.isInteger(plan.sequence) && plan.parentId === month?.id && plan.sourceKey === sourceKey && sourceKey !== null, `transfer_plan:${fixture.fileId}`);
    check(drive && drive.id === plan?.id && drive.name === plan?.name && exact(drive.parents, [month?.id]) && drive.mimeType === fixture.contentType && drive.size === String(fixture.size) && drive.md5Checksum === Buffer.from(fixture.md5Base64, 'base64').toString('hex') && drive.appProperties?.lkcTransfer === sourceKey && drive.trashed === false, `drive_content:${fixture.fileId}`);
    const completedAt = timestamp(file?.completedAt);
    check(Number.isFinite(completedAt) && completedAt >= startedAt && completedAt <= readAt && completedAt === timestamp(file?.transferCompletedAt) && completedAt === timestamp(drive?.createdTime), `completion_time:${fixture.fileId}`);
    sequences.push(file?.sequence); completionTimes.push(completedAt);
  }
  check(exact(sequences.sort((a, b) => a - b), [1, 2]), 'unique_sequences');
  const last = Math.max(...completionTimes);
  check(Number.isFinite(last) && timestamp(submission?.completedAt) === last && timestamp(report?.firstCompletedAt) === last && timestamp(report?.latestCompletedAt) === last, 'final_completion_time');
  const queue = queues[0]?.data;
  check(queue?.companyId === kit.companyId && queue?.jobId === kit.jobId && queue?.operation === 'submission.report' && queue?.status === 'blocked' && queue?.errorType === 'blocked' && queue?.errorMessage === '安全書込がまだ有効化されていません。' && Number.isInteger(queue?.attempts) && queue.attempts >= 1 && queue?.retryAt === null && exact(queue?.updates, { reportSubmitted: '遅延' }) && queue?.idempotencyKey === `submission:report:${kit.jobId}:${last}` && timestamp(queue?.createdAt) === last, 'sheet_write_blocked');
  for (const collection of ['notificationQueue', 'pushTokens']) check(result?.counts?.[collection]?.companyId === kit.companyId && result?.counts?.[collection]?.count === 0, `no_side_effects:${collection}`);
  check(result?.listingsComplete === true, 'complete_resource_listings');
  return { mode: 'local-evidence-check', passed: issues.length === 0, issues, cloudExecutionAuthorized: false, actualCloudAcceptanceVerified: false };
}
