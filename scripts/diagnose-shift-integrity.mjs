import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const assigned = job => job.status === 'assigned' && job.cancelled !== true;
const key = (company, staff, day) => `${company}_${staff}_${day}`;

// 入力スナップショットのみを走査する。DB接続・修復・外部送信は持たない。
export function diagnoseShiftIntegrity(input) {
  if (!input || !text(input.companyId) || !Array.isArray(input.jobs) || !Array.isArray(input.locks)) throw new Error('診断入力にcompanyId/jobs/locksが必要です。');
  const companyId = input.companyId;
  const complete = { jobs: input.complete?.jobs === true, locks: input.complete?.locks === true };
  const indexes = {};
  for (const kind of ['jobs', 'locks']) {
    const index = new Map();
    for (const record of input[kind]) {
      if (!record || !text(record.id) || !text(record.companyId)) throw new Error('レコードのid/companyIdが不正です。');
      if (record.companyId !== companyId) throw new Error('別会社のデータが混在しています。会社ごとに分けてください。');
      if (index.has(record.id)) throw new Error('同じ文書IDが重複しています。');
      index.set(record.id, record);
    }
    indexes[kind] = index;
  }
  const findings = [];
  const add = (code, severity, jobIds = [], lockIds = []) => findings.push({ code, severity, jobIds: [...new Set(jobIds)].sort(), lockIds: [...new Set(lockIds)].sort() });
  const assignments = new Map();
  for (const job of indexes.jobs.values()) {
    if (!assigned(job)) continue;
    if (!text(job.assignedStaffId) || !date(job.dateKey)) { add('INVALID_ASSIGNMENT', 'error', [job.id]); continue; }
    const lockId = key(companyId, job.assignedStaffId, job.dateKey);
    const group = assignments.get(lockId) ?? [];
    group.push(job.id); assignments.set(lockId, group);
    const lock = indexes.locks.get(lockId);
    if (!lock) add(complete.locks ? 'MISSING_LOCK' : 'LOCK_NOT_IN_SNAPSHOT', complete.locks ? 'error' : 'unknown', [job.id], [lockId]);
    else if (lock.active === false) add('INACTIVE_ASSIGNED_LOCK', 'error', [job.id], [lock.id]);
    else if (lock.active === true && lock.jobId !== job.id) add('LOCK_OWNER_MISMATCH', 'error', [job.id], [lock.id]);
  }
  for (const [id, jobs] of assignments) if (jobs.length > 1) add('DUPLICATE_ASSIGNMENT', 'error', jobs, [id]);
  for (const lock of indexes.locks.values()) {
    if (typeof lock.active !== 'boolean') add('AMBIGUOUS_LOCK_STATE', 'error', [], [lock.id]);
    if (!text(lock.staffId) || !date(lock.dateKey) || !text(lock.jobId) || lock.id !== key(companyId, lock.staffId, lock.dateKey)) add('INVALID_LOCK_METADATA', 'error', [], [lock.id]);
    if (lock.active !== true) continue;
    const job = indexes.jobs.get(lock.jobId);
    if (!job) { add(complete.jobs ? 'ORPHAN_ACTIVE_LOCK' : 'JOB_NOT_IN_SNAPSHOT', complete.jobs ? 'error' : 'unknown', [], [lock.id]); continue; }
    if (!assigned(job)) add('ACTIVE_LOCK_FOR_INACTIVE_JOB', 'error', [job.id], [lock.id]);
    else if (job.assignedStaffId !== lock.staffId || job.dateKey !== lock.dateKey) add('LOCK_ASSIGNMENT_MISMATCH', 'error', [job.id], [lock.id]);
  }
  findings.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const counts = { error: 0, unknown: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { version: 1, companyId, complete, status: counts.error ? 'attention_required' : counts.unknown || !complete.jobs || !complete.locks ? 'unverified' : 'consistent', scanned: { jobs: indexes.jobs.size, locks: indexes.locks.size }, counts, findings };
}

export function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('使用法: node scripts/diagnose-shift-integrity.mjs --input snapshot.json --output report.json');
  const inputPath = path.resolve(args[1]), outputPath = path.resolve(args[3]);
  if (inputPath === outputPath) throw new Error('入力ファイルへの上書きはできません。');
  const report = diagnoseShiftIntegrity(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  // 既存の証跡も上書きせず、内容にスタッフ名・メール・金額などの余分な入力を含めない。
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, scanned: report.scanned, counts: report.counts }));
  return report.status === 'consistent' ? 0 : report.status === 'unverified' ? 3 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = runCli(process.argv.slice(2)); }
  catch { console.error('診断できませんでした。引数、会社・ID、入力JSON、出力先の既存ファイルを確認してください。'); process.exitCode = 1; }
}