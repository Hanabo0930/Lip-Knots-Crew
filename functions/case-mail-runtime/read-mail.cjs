'use strict';
const c = require('./core.js'), intake = require('./intake.js'), mail = require('./mail-source.cjs');
const MAX_BYTES = 25 * 1024 * 1024;
class GmailReadClient {
  constructor({ obtainAccessToken, fetchImpl = globalThis.fetch }) {
    c.ensure(typeof obtainAccessToken === 'function' && typeof fetchImpl === 'function', 'Gmailの読取り認証が必要です');
    this.token = obtainAccessToken; this.fetch = fetchImpl;
  }
  async get(path, query = {}) {
    const token = await this.token(); c.ensure(typeof token === 'string' && token, 'Gmailの読取り認証が必要です');
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try { response = await this.fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw Error('Gmailの読取り通信に失敗しました'); }
    c.ensure(response.ok, 'Gmailの読取りに失敗しました（HTTP ' + response.status + '）');
    try { return await response.json(); } catch { throw Error('Gmailの応答が不完全です'); }
  }
  getMessage(id) { c.ensure(/^[A-Za-z0-9_-]+$/.test(id), 'メールIDが不正です'); return this.get('messages/' + id, { format: 'full' }); }
  getAttachment(messageId, attachmentId) { c.ensure(typeof attachmentId === 'string' && attachmentId && /^[A-Za-z0-9_-]+$/.test(messageId), '添付の出典が不正です'); return this.get('messages/' + messageId + '/attachments/' + encodeURIComponent(attachmentId)); }
  async list({ startedAt, pageToken, maxResults = 25 }) {
    const start = intake.instant(startedAt, '運用開始日時');
    c.ensure(Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= 100, '取得件数を1〜100で指定してください');
    const response = await this.get('messages', { q: 'to:info@lipknots.com after:' + Math.max(0, Math.floor(start / 1000) - 1) + ' -in:spam -in:trash', maxResults, pageToken });
    c.ensure(!response.messages || Array.isArray(response.messages), 'メール一覧の応答が不完全です');
    return { messages: response.messages || [], nextPageToken: response.nextPageToken || null, complete: !response.nextPageToken };
  }
}
function attachmentBytes(data, expectedSize) {
  c.ensure(Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= MAX_BYTES, '添付サイズが取得上限を超えています');
  c.ensure(typeof data === 'string' && data.length <= MAX_BYTES * 1.34 + 4 && /^[A-Za-z0-9_-]*={0,2}$/.test(data) && data.length % 4 !== 1, '添付のbase64urlが不正です');
  const bytes = Buffer.from(data, 'base64url');
  c.ensure(bytes.length === expectedSize && bytes.toString('base64url') === data.replace(/=+$/, ''), '添付の取得が不完全です'); return bytes;
}
async function readRequest(client, messageId, options) {
  intake.instant(options?.startedAt, '運用開始日時'); // 未設定なら通信そのものを始めない。
  const raw = await client.getMessage(messageId);
  c.ensure(raw.id === messageId, '取得したメールIDが要求と違います');
  const message = mail.normalize(raw), eligibility = mail.gate(message, options);
  if (eligibility !== 'ELIGIBLE') return { message, eligibility, attachments: [], complete: true };
  const attachments = [];
  for (const descriptor of message.attachments) {
    c.ensure(Number.isSafeInteger(descriptor.size) && descriptor.size <= MAX_BYTES, '添付サイズが取得上限を超えています');
    const body = descriptor.data !== null ? { data: descriptor.data, size: descriptor.size } : await client.getAttachment(messageId, descriptor.attachmentId);
    c.ensure(body.size === descriptor.size, '添付の元サイズと取得結果が違います');
    const bytes = attachmentBytes(body.data, descriptor.size), magic = bytes.subarray(0, 5).toString('ascii');
    const detected = magic === '%PDF-' ? 'pdf' : bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4 ? 'xlsx' : 'unknown';
    attachments.push({ messageId, partId: descriptor.partId, descriptor, bytes, detected, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
  }
  return { message, eligibility, attachments, complete: true };
}
module.exports = { GmailReadClient, readRequest, attachmentBytes };
