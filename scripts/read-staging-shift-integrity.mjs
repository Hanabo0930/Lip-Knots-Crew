import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnoseShiftIntegrity } from './diagnose-shift-integrity.mjs';

export const PROJECT = 'lip-knots-crew-staging';
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const FIELDS = {
  jobs: ['companyId', 'status', 'cancelled', 'assignedStaffId', 'dateKey'],
  staffDayLocks: ['companyId', 'jobId', 'staffId', 'dateKey', 'active'],
};
const fail = code => { throw new Error(code); };

// 接続先・操作・取得項目を固定。書込、同期、通知、認証設定変更は持たない。
export function createReadTransport(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) fail('TOKEN_REQUIRED');
  return async (operation, body) => {
    if (!['beginTransaction', 'runQuery', 'rollback'].includes(operation)) fail('OPERATION_DENIED');
    let response;
    try {
      response = await fetchImpl(`https://firestore.googleapis.com/v1/${ROOT}:${operation}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { fail('NETWORK_FAILED'); }
    if (!response.ok) fail(`HTTP_${response.status}`);
    try { return await response.json(); } catch { fail('INVALID_RESPONSE'); }
  };
}

function records(response, collection, companyId, cap) {
  if (!Array.isArray(response) || response.length === 0) fail('INCOMPLETE_RESPONSE');
  const rows = [], seen = new Set();
  for (const item of response) {
    if (!item || item.error || item.skippedResults || !item.readTime || !Number.isFinite(Date.parse(item.readTime))) fail('INCOMPLETE_RESPONSE');
    if (!item.document) continue;
    const doc = item.document, prefix = `${ROOT}/${collection}/`;
    if (typeof doc.name !== 'string' || !doc.name.startsWith(prefix)) fail('DOCUMENT_SCOPE');
    const id = doc.name.slice(prefix.length);
    if (!id || id.includes('/') || seen.has(id)) fail('DOCUMENT_ID');
    seen.add(id);
    const record = { id };
    for (const field of FIELDS[collection]) {
      const value = doc.fields?.[field];
      if (value === undefined) continue;
      if (value && Object.keys(value).length === 1 && typeof value.stringValue === 'string') record[field] = value.stringValue;
      else if (value && Object.keys(value).length === 1 && typeof value.booleanValue === 'boolean') record[field] = value.booleanValue;
      else if (value && Object.keys(value).length === 1 && 'nullValue' in value) record[field] = null;
      else fail('UNSUPPORTED_FIELD_TYPE');
    }
    if (record.companyId !== companyId) fail('COMPANY_MISMATCH');
    rows.push(record);
  }
  if (rows.length > cap) fail('LIMIT_EXCEEDED');
  return rows;
}

export async function collectStagingIntegrity({ companyId, request, cap = 10000 }) {
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) fail('COMPANY_REQUIRED');
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000) fail('INVALID_LIMIT');
  const startedAt = new Date().toISOString();
  const begin = await request('beginTransaction', { options: { readOnly: {} } });
  if (typeof begin?.transaction !== 'string' || !begin.transaction) fail('TRANSACTION_REQUIRED');
  const transaction = begin.transaction;
  let snapshot, originalError;
  try {
    snapshot = { companyId, complete: { jobs: true, locks: true }, jobs: [], locks: [] };
    for (const [collection, kind] of [['jobs', 'jobs'], ['staffDayLocks', 'locks']]) {
      const response = await request('runQuery', {
        transaction,
        structuredQuery: {
          from: [{ collectionId: collection }],
          select: { fields: FIELDS[collection].map(fieldPath => ({ fieldPath })) },
          where: { fieldFilter: { field: { fieldPath: 'companyId' }, op: 'EQUAL', value: { stringValue: companyId } } },
          limit: cap + 1,
        },
      });
      snapshot[kind] = records(response, collection, companyId, cap);
    }
  } catch (error) { originalError = error; }
  // 読取専用transactionを閉じる。失敗時もデータのcommitは実行しない。
  try { await request('rollback', { transaction }); }
  catch { fail('READ_TRANSACTION_CLOSE_FAILED'); }
  if (originalError) throw originalError;
  const report = diagnoseShiftIntegrity(snapshot);
  if (report.scanned.jobs === 0 && report.scanned.locks === 0) report.status = 'unverified';
  report.source = {
    projectId: PROJECT, databaseId: '(default)', mode: 'read-only-transaction',
    startedAt, finishedAt: new Date().toISOString(), maxDocumentsPerCollection: cap,
    scope: 'companyId equality; documents without this companyId are excluded',
    emptyScope: report.scanned.jobs === 0 && report.scanned.locks === 0,
  };
  return report;
}

export async function runCli(args, token, fetchImpl = fetch) {
  if (args.length !== 4 || args[0] !== '--company' || args[2] !== '--output') fail('ARGUMENTS_REQUIRED');
  const output = path.resolve(args[3]);
  // 既存証跡を守り、取得前に出力先が書けるか確認する。失敗時は完了レポートにしない。
  const fd = fs.openSync(output, 'wx', 0o600);
  try {
    const report = await collectStagingIntegrity({ companyId: args[1], request: createReadTransport(token, fetchImpl) });
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, scanned: report.scanned, counts: report.counts, projectId: PROJECT }));
    return report.status === 'consistent' ? 0 : report.status === 'unverified' ? 3 : 2;
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runCli(process.argv.slice(2), fs.readFileSync(0, 'utf8').trim()); }
  catch (error) {
    const code = /^(HTTP_\d{3}|[A-Z_]+)$/.test(error.message) ? error.message : 'READ_FAILED';
    console.error(`読取診断は未完了です (${code})。出力が空の場合は診断結果ではありません。`);
    process.exitCode = 1;
  }
}
