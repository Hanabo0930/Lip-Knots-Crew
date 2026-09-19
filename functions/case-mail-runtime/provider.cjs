'use strict';
const { GmailReadClient, readRequest } = require('./read-mail.cjs');
const { createHash } = require('node:crypto');
const mail = require('./mail-source.cjs');
const { MAX_INPUT_BYTES } = require('./preview.cjs');
// 旧抽出サービスの既知STAGING接続先。入力からURL/宛先を選ばせない。
const EXTRACTOR_ORIGIN = 'https://lkcm-attachment-extractor-740154137290.asia-northeast1.run.app';
const MAX_EXTRACTION_BYTES = 40 * 1024 * 1024;
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function extractionJson(response) {
  ensure(response.ok, '添付抽出サービスに接続できません。');
  const declared = Number(response.headers.get('content-length'));
  ensure(!Number.isFinite(declared) || declared <= MAX_EXTRACTION_BYTES, '添付抽出結果が上限を超えています。');
  ensure(response.body && typeof response.body.getReader === 'function', '添付抽出応答が不完全です。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      ensure(size <= MAX_EXTRACTION_BYTES, '添付抽出結果が上限を超えています。');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function createGmailCaseMailProvider({ mailbox, startedAt, obtainAccessToken, obtainExtractionCredentials,
  analyze, fetchImpl = globalThis.fetch }) {
  ensure(mailbox === 'info@lipknots.com' && Number.isFinite(Date.parse(startedAt)), '受信箱・開始日時を確認してください。');
  ensure([obtainAccessToken, obtainExtractionCredentials, analyze, fetchImpl].every(fn => typeof fn === 'function'), 'サーバーの取得・抽出設定が不足しています。');
  return {
    async fetch(request) {
      ensure(request && request.mailbox === mailbox && /^[A-Za-z0-9_-]+$/.test(request.messageId), '受信箱・メールIDが一致しません。');
      let accessToken;
      try { accessToken = await obtainAccessToken(); } catch { throw Error('Gmail読取認証を取得できません。'); }
      ensure(typeof accessToken === 'string' && accessToken.length > 0 && !/\s/.test(accessToken), 'Gmail読取認証が不正です。');
      // profile/本文/全添付は同じ短期トークンを使用して取得アカウントの混在を防ぐ。
      const client = new GmailReadClient({ obtainAccessToken: async () => accessToken, fetchImpl });
      const profile = await client.get('profile');
      ensure(typeof profile.emailAddress === 'string' && profile.emailAddress.toLowerCase() === mailbox,
        'Gmailの認証先が指定受信箱と一致しません。');
      let rawMessage;
      const result = await readRequest({
        getMessage: async id => {
          rawMessage = await client.getMessage(id);
          const rawSize = Buffer.byteLength(JSON.stringify(rawMessage));
          ensure(rawSize <= MAX_INPUT_BYTES, "メール全体が解析入力の上限を超えています。");
          const normalized = mail.normalize(rawMessage);
          if (mail.gate(normalized, { startedAt }) === "ELIGIBLE") {
            const encodedAttachmentSize = normalized.attachments.reduce((size, part) => size + Math.ceil(part.size / 3) * 4, 0);
            ensure(rawSize + encodedAttachmentSize <= MAX_INPUT_BYTES, "添付合計が解析入力の上限を超えています。");
          }
          return rawMessage;
        },
        getAttachment: (id, attachmentId) => client.getAttachment(id, attachmentId),
      }, request.messageId, { startedAt });
      if (result.eligibility !== 'ELIGIBLE') return { rawMessage, documents: [] };
      const documents = [];
      let credentials;
      for (const item of result.attachments) {
        const mime = item.detected === 'pdf' ? 'application/pdf' :
          item.detected === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : null;
        ensure(mime && item.descriptor.mimeType === mime, '添付の実体と申告形式が一致しません。');
        if (!credentials) {
          try { credentials = await obtainExtractionCredentials(EXTRACTOR_ORIGIN); }
          catch { throw Error('添付抽出の認証を取得できません。'); }
          ensure(credentials && typeof credentials.secret === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(credentials.secret) &&
            typeof credentials.idToken === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credentials.idToken),
          '添付抽出の認証が不正です。');
        }
        let extraction;
        try {
          const response = await fetchImpl(EXTRACTOR_ORIGIN + '/v1/' + item.detected, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
            headers: { 'Content-Type': mime, Authorization: 'Bearer ' + credentials.secret,
              'X-Serverless-Authorization': 'Bearer ' + credentials.idToken },
            body: item.bytes,
          });
          extraction = await extractionJson(response);
        } catch { throw Error('添付抽出に失敗しました。原本と接続設定を確認してください。'); }
        ensure(extraction && extraction.format === item.detected && extraction.sha256 === digest(item.bytes) &&
          extraction.bytes === item.bytes.length && typeof extraction.complete === 'boolean', '添付抽出結果と取得した原本が一致しません。');
        documents.push({ partId: item.partId, contentBase64: item.bytes.toString('base64'), extraction });
      }
      return { rawMessage, documents };
    },
    parse: analyze,
  };
}
module.exports = { createGmailCaseMailProvider, EXTRACTOR_ORIGIN };
