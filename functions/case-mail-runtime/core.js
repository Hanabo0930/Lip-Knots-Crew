'use strict';

// 外部サービスを呼ばない共通処理。ブラウザーとNodeで同じ判定を検証する。
const LKCase = (() => {
  const STAFF_ADDRESS = 'staff@lipknots.com';
  const TOHOKU = Object.freeze(['青森県', '秋田県', '岩手県', '福島県', '山形県']);
  const PREFECTURES = ('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県').split(' ');
  const PENDING_POLICIES = Object.freeze({ partialImport: null, conflictingSources: null, notificationCadence: null, cancellationEntry: null, stalePreview: null });
  const clone = value => JSON.parse(JSON.stringify(value));
  const timestampFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function jstTimestamp(value) {
    const stamp = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(stamp) ? timestampFormat.format(stamp) + '（日本時間）' : '日時の記録なし';
  }
  function ensure(ok, message) { if (!ok) throw new Error(message); }
  function date(value) {
    ensure(typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value), '年月日をYYYY-MM-DDで指定してください');
    const stamp = Date.parse(value + 'T00:00:00Z');
    ensure(Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value, '存在しない日付です');
    return value;
  }
  function jstDay(instant) {
    const stamp = new Date(instant).getTime();
    ensure(Number.isFinite(stamp), '現在時刻が不正です');
    return new Date(stamp + 9 * 3600000).toISOString().slice(0, 10);
  }
  function hasLocationIdentity(row) {
    return !!row && [row.client, row.store].every(value => typeof value === 'string' && value.trim());
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function region(location) {
    // 店名だけ、推測、同名店舗の候補では地域を確定しない。
    if (!location || location.verified !== true || typeof location.source !== 'string' || !location.source.trim() || !PREFECTURES.includes(location.prefecture)) return null;
    return TOHOKU.includes(location.prefecture) ? 'tohoku' : 'normal';
  }
  function cancelled(row) {
    return row.cancelled === true || /キャンセル|中止|取消/.test([row.client, row.store, row.memo, row.staffName].join(' '));
  }
  function conditionIssues(row) {
    return [row.locationReviewReason, row.billingState === 'REVIEW' ? '請求単価の確認が必要です' : ''].filter(value => typeof value === 'string' && value.trim());
  }
  function collectRecruitment(rows, { today, start, end, selectedIds } = {}) {
    date(today);
    if (start) date(start);
    if (end) date(end);
    ensure(!start || !end || start <= end, '募集期間の開始日が終了日より後です');
    const selected = selectedIds === undefined ? null : new Set(selectedIds);
    const ids = new Map();
    rows.forEach(row => { if (row.id) ids.set(row.id, (ids.get(row.id) || 0) + 1); });
    const groups = { normal: [], tohoku: [] }, excluded = [], issues = [];
    for (const row of rows) {
      if (selected && !selected.has(row.id)) continue;
      const skip = reason => excluded.push({ id: row.id || '', reason });
      if (row.kind !== 'case') { skip('案件行ではありません'); continue; }
      try { date(row.day); } catch (error) { issues.push({ id: row.id || '', reason: error.message }); continue; }
      if (row.day <= today || (start && row.day < start) || (end && row.day > end)) { skip('募集期間外'); continue; }
      // 空白だけが対象。「募集中」「未定」は対象にしない。
      if (row.staffName !== '' && row.staffName !== null && row.staffName !== undefined) { skip('スタッフ名が空欄ではありません'); continue; }
      if (cancelled(row) || row.excluded || row.reviewPending || /ラウンダー/.test([row.product, row.memo, row.jobType].join(' '))) { skip('キャンセル・除外・確認待ち・ラウンダー'); continue; }
      const pending = conditionIssues(row);
      if (pending.length) { pending.forEach(reason => issues.push({ id: row.id || '', reason })); continue; }
      if (typeof row.id !== 'string' || !row.id.trim() || ids.get(row.id) !== 1) { issues.push({ id: row.id || '', reason: '固定案件IDが空欄・不正または重複しています' }); continue; }
      if (!hasLocationIdentity(row)) { issues.push({ id: row.id, reason: 'クライアントまたは店舗が不明です' }); continue; }
      const area = region(row.location);
      if (!area) { issues.push({ id: row.id, reason: '店舗所在地の確認が必要です' }); continue; }
      groups[area].push(clone(row));
    }
    Object.values(groups).forEach(group => group.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)));
    return { groups, excluded, issues };
  }
  function normalizeEmail(value) {
    // ヘッダー注入、複数宛先、表示名を受け付けない。到達可能性とは別の形式検査。
    if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
    const address = value.trim();
    if (address.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address)) return null;
    const [local, domain] = address.split('@');
    if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some(label => label.length > 63)) return null;
    return address.toLowerCase();
  }
  function recipients(staff, area) {
    ensure(['normal', 'tohoku'].includes(area), '地域区分が不正です');
    const list = area === 'tohoku' ? '東北' : 'マスターデータ';
    const seen = new Set(), bcc = [], excluded = [];
    for (const person of staff.filter(person => person.list === list)) {
      const address = normalizeEmail(person.email);
      if (!address) { excluded.push({ id: person.id, name: person.name, reason: 'アドレスが空欄または形式不正' }); continue; }
      if (address === STAFF_ADDRESS) { excluded.push({ id: person.id, name: person.name, reason: 'Toの共通アドレスと同じ' }); continue; }
      if (seen.has(address)) { excluded.push({ id: person.id, name: person.name, reason: '同じ配信内の重複アドレス' }); continue; }
      seen.add(address); bcc.push(address);
    }
    return { from: STAFF_ADDRESS, replyTo: STAFF_ADDRESS, to: STAFF_ADDRESS, cc: [], bcc, excluded };
  }
  function draft({ rows, staff, area, today, selection, template, operationId }) {
    ensure(operationId && typeof operationId === 'string', '送信操作IDが必要です');
    ensure(template && typeof template.render === 'function', '募集書式が必要です');
    const gathered = collectRecruitment(rows, { ...selection, today });
    ensure(['normal', 'tohoku'].includes(area), '地域区分が不正です');
    const cases = gathered.groups[area], addresses = recipients(staff, area);
    ensure(cases.length > 0, '募集対象案件がありません');
    ensure(addresses.bcc.length > 0, '有効な配信先がありません');
    // テンプレートへ宛先リストを渡さない。
    const rendered = template.render(clone(cases), area);
    ensure(typeof rendered.subject === 'string' && rendered.subject.trim() && !/[\r\n]/.test(rendered.subject), '件名が不正です');
    ensure(typeof rendered.body === 'string' && rendered.body.trim(), '本文が空です');
    const renderIssues = rendered.issues === undefined ? [] : rendered.issues;
    ensure(Array.isArray(renderIssues) && renderIssues.every(x => x && typeof x.reason === 'string' && x.reason.trim()), '募集書式の確認結果が不正です');
    return {
      operationId, area, subject: rendered.subject, body: rendered.body, addresses,
      cases, selection: clone(selection || {}), today, issues: [...gathered.issues, ...clone(renderIssues)],
      template: { id: template.id || '', source: template.source || '', verified: template.verified === true },
      snapshot: canonical({ cases, addresses }), state: 'PREVIEW', edited: false
    };
  }
  function editBody(preview, body) {
    ensure(preview.state === 'PREVIEW' && typeof body === 'string' && body.trim(), '編集中の本文を確認してください');
    return { ...clone(preview), body, edited: true };
  }
  function validateDraft(preview, rows, staff, today) {
    const current = collectRecruitment(rows, { ...preview.selection, today });
    const addresses = recipients(staff, preview.area);
    const reasons = [];
    if (!Array.isArray(preview.issues) || preview.issues.length) reasons.push('募集本文または案件の確認事項が残っています');
    if (canonical({ cases: current.groups[preview.area], addresses }) !== preview.snapshot) reasons.push('案件または宛先がプレビュー後に変わりました');
    if (!preview.template.verified || !preview.template.source) reasons.push('募集書式の現物確認が未完了です');
    // 未回答⑤の処理方法を確定せず、古いプレビューは止めて原文を保持する。
    return { ok: reasons.length === 0, reasons, preservedBody: preview.body };
  }
  function reserveOperation(ledger, { operationId, area, now }) {
    ensure(operationId && ['normal', 'tohoku'].includes(area), '送信操作の識別情報が不正です');
    const key = JSON.stringify([operationId, area]);
    ensure(!Object.prototype.hasOwnProperty.call(ledger, key), '処理済み・処理中・結果不明の同じ操作は再実行できません');
    return { ...clone(ledger), [key]: { state: 'SENDING', at: now } };
  }
  function finishOperation(ledger, { operationId, area, state, receipt, now }) {
    const key = JSON.stringify([operationId, area]);
    ensure(ledger[key]?.state === 'SENDING', '処理中の操作がありません');
    ensure(['SENT', 'UNCERTAIN', 'FAILED'].includes(state), '送信結果の状態が不正です');
    if (state === 'SENT') ensure(receipt, '送信済みには送信記録が必要です');
    return { ...clone(ledger), [key]: { ...ledger[key], state, receipt: receipt || null, completedAt: now } };
  }
  function shortPay(start, end) {
    const minute = text => { ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(text), '実施時間をHH:mmで指定してください'); return Number(text.slice(0, 2)) * 60 + Number(text.slice(3)); };
    const duration = minute(end) - minute(start);
    ensure(duration > 0, '日またぎ・開始終了の逆転は確認が必要です');
    return duration < 360 ? { salary: 5000, allowance: 2000, total: 7000, minutes: duration } : null;
  }
  return { STAFF_ADDRESS, TOHOKU, PREFECTURES, PENDING_POLICIES, clone, ensure, date, jstDay, jstTimestamp, hasLocationIdentity, canonical, region, cancelled, conditionIssues, collectRecruitment, normalizeEmail, recipients, draft, editBody, validateDraft, reserveOperation, finishOperation, shortPay };
})();
if (typeof module !== 'undefined') module.exports = LKCase;
