'use strict';
const c = require('./core.js'), intake = require('./intake.js'), crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(c.canonical(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
function addresses(value) {
  // 表示名中のカンマは区切らない。曖昧なアドレス一覧を部分成功にしない。
  const fields = []; let token = '', quoted = false, angled = false, escape = false;
  for (const char of value) {
    if (escape) { token += char; escape = false; continue; }
    if (quoted && char === '\\') { token += char; escape = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') angled = true;
    if (!quoted && char === '>') angled = false;
    if (!quoted && !angled && char === ',') { fields.push(token); token = ''; } else token += char;
  }
  c.ensure(!quoted && !angled && !escape, 'メールアドレスの括りが不完全です'); fields.push(token);
  return fields.filter(v => v.trim()).map(value => {
    const match = /^(?:[^<>]*)<([^<>]+)>\s*$/.exec(value.trim());
    const address = c.normalizeEmail(match ? match[1] : value.trim());
    c.ensure(address, 'メールアドレスを一意に読めません'); return address;
  });
}
function normalize(raw, { decode } = {}) {
  c.ensure(identifier(raw?.id) && raw.payload, '元メールをfull形式で取得してください');
  const received = raw.internalDate ?? raw.internal_date;
  c.ensure(typeof received === 'string' && /^\d+$/.test(received) && Number.isSafeInteger(Number(received)) && Number(received) <= 8640000000000000, 'Gmail受信日時が不正です');
  const headers = name => (raw.payload.headers || []).filter(h => String(h.name).toLowerCase() === name).map(h => h.value);
  const one = name => { const list = headers(name); c.ensure(list.length === 1 && typeof list[0] === 'string', 'メールヘッダーの重複・欠落：' + name); return list[0]; };
  const from = addresses(one('from')); c.ensure(from.length === 1, '送信元を一意に確認してください');
  const issues = [], attachments = [], bodyParts = [], partsSeen = new Set(); let nodes = 0;
  function bodyText(part) {
    const body = part.body || {}, encoded = body.data ?? body.base64_url_content;
    if (typeof body.content === 'string') return body.content;
    if (body.attachmentId || body.attachment_id) { issues.push('本文の別取得が必要です：' + (part.partId ?? part.part_id)); return ''; }
    if (body.size === 0 && !encoded) return '';
    c.ensure(typeof encoded === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(encoded) && encoded.length % 4 !== 1, '本文のbase64urlが不正です');
    const type = (part.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1] || 'utf-8';
    if (decode) return decode(encoded, charset, body.size);
    const bytes = Buffer.from(encoded, 'base64url');
    c.ensure(bytes.toString('base64url') === encoded.replace(/=+$/, '') && bytes.length === body.size, '本文の取得サイズが一致しません');
    try { return new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { throw Error('本文の文字コードを確認してください：' + charset); }
  }
  function visit(part, depth = 0, bodySelected = true) {
    c.ensure(part && ++nodes <= 500 && depth <= 20, 'メールの構造が上限を超えています');
    const id = part.partId ?? part.part_id;
    c.ensure(typeof id === 'string' && !partsSeen.has(id), 'メール内の出典位置が重複・欠落しています'); partsSeen.add(id);
    const mime = String(part.mimeType ?? part.mime_type).toLowerCase(), filename = part.filename || '';
    const disposition = (part.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
    if (filename || /^attachment\b/i.test(disposition) || mime === 'message/rfc822') {
      const body = part.body || {};
      attachments.push({ partId: id, filename, mimeType: mime, size: body.size, attachmentId: body.attachmentId ?? body.attachment_id ?? null, data: body.data ?? body.base64_url_content ?? null });
      if (mime === 'message/rfc822') issues.push('転送メール添付の区別が必要です');
      return;
    }
    if (mime.startsWith('multipart/')) {
      if (/encrypted|signed/.test(mime)) issues.push('暗号化・署名付きメールの確認が必要です');
      c.ensure(Array.isArray(part.parts) && part.parts.length, 'メール本文の構造が不完全です');
      if (mime === 'multipart/alternative') {
        const plain = part.parts.filter(p => (p.mimeType ?? p.mime_type) === 'text/plain');
        if (plain.length === 1) { part.parts.forEach(p => visit(p, depth + 1, bodySelected && p === plain[0])); return; }
        if (plain.length > 1) issues.push('本文候補が複数あります');
      }
      part.parts.forEach(p => visit(p, depth + 1, bodySelected)); return;
    }
    if (mime === 'text/plain' || mime === 'text/html') {
      if (!bodySelected) return;
      if (mime === 'text/html') issues.push('HTML本文の内容確認が必要です');
      bodyParts.push({ partId: id, mimeType: mime, text: bodyText(part) });
    } else issues.push('未対応の本文形式：' + mime);
  }
  visit(raw.payload);
  const body = bodyParts.filter(p => p.mimeType === 'text/plain').map(p => p.text).join('\n');
  if (bodyParts.filter(p => p.mimeType === 'text/plain').length > 1) issues.push('複数本文の区別が必要です');
  const quote = /^\s*>|^\s*(?:From|Sent|差出人|送信日時):|Original Message|wrote:|^\d{4}年.+<.+>:/m.test(body);
  if (quote) issues.push('引用返信を含みます。今回の依頼範囲を確認してください');
  const result = { id: raw.id, threadId: raw.threadId ?? raw.thread_id, receivedAt: new Date(Number(received)).toISOString(), from: from[0], to: addresses(headers('to').join(',')), cc: addresses(headers('cc').join(',')), subject: one('subject'), body, bodyParts, attachments, issues };
  // Gmailの取得用attachmentIdは再取得で変わる。内容の照合には使わず、添付実体は取込み時にSHA-256で別途照合する。
  result.fingerprint = hash({ ...result, attachments: attachments.map(({ attachmentId, ...stable }) => stable) }); return result;
}
function gate(message, { startedAt, processedIds = [] } = {}) {
  const start = intake.instant(startedAt, '運用開始日時'), received = intake.instant(message.receivedAt, '受信日時');
  c.ensure(Array.isArray(processedIds) && processedIds.every(identifier), '取込み済みメールIDが不正です');
  if (processedIds.includes(message.id)) return 'ALREADY_PROCESSED';
  if (received < start) return 'BEFORE_START';
  if (!message.to.includes('info@lipknots.com')) return 'NOT_CLIENT_INBOX';
  return 'ELIGIBLE';
}
module.exports = { normalize, addresses, gate, hash };
