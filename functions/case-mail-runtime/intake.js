'use strict';

const LKIntake = (() => {
  const core = typeof module !== 'undefined' ? require('./core.js') : LKCase;
  const business = typeof module !== 'undefined' ? require('./business-rules.js') : LKBusiness;
  const { ensure, clone, date, canonical } = core;
  const EDITABLE = Object.freeze(['day', 'client', 'store', 'maker', 'product', 'time', 'bill', 'plannedArrival', 'timePlanned']);
  const IMPORT_FIELDS = Object.freeze([...EDITABLE.filter(field => field !== 'timePlanned'), 'days', 'headcount', 'externalId']);
  const REQUIRED = Object.freeze(['day', 'client', 'store', 'time']);
  function newRule(input = {}) {
    ensure(input && typeof input === 'object' && !Array.isArray(input), '取込みパターンを項目形式で指定してください');
    const { id, client, sender, subjectContains, mode, messageId, mapping, version = 1, source } = input;
    const nonblank = value => typeof value === 'string' && value.trim();
    ensure(nonblank(id) && id === id.trim() && !/[\r\n]/.test(id) && nonblank(client) && nonblank(source), 'ルールID・取引先・根拠を空欄でない文字列で指定してください');
    ensure(core.normalizeEmail(sender), '取引先の送信元アドレスが不正です');
    ensure(['once', 'reusable'].includes(mode), '今回限りか次回以降も使用かを指定してください');
    ensure(mode !== 'once' || nonblank(messageId) && messageId === messageId.trim() && !/[\r\n]/.test(messageId), '今回限りの元メールIDが必要です');
    ensure(nonblank(subjectContains), '件名の適用条件が必要です');
    ensure(Number.isSafeInteger(version) && version > 0, 'ルール版が不正です');
    ensure(mapping && typeof mapping === 'object' && !Array.isArray(mapping) && Object.keys(mapping).length, '読取り項目が必要です');
    const used = new Set(), normalizedMapping = {};
    Object.entries(mapping).forEach(([field, label]) => {
      ensure(IMPORT_FIELDS.includes(field) && typeof label === 'string' && label.trim() && !/[\r\n:：]/.test(label), '項目の指定が不正です');
      const normalized = label.trim();
      ensure(!used.has(normalized), '同じ見出しを複数項目へ割り当てられません');
      used.add(normalized); normalizedMapping[field] = normalized;
    });
    return { id, client, sender: core.normalizeEmail(sender), subjectContains, mode, messageId: messageId || null, mapping: normalizedMapping, version, source };
  }
  function selectRule(message, rules) {
    const sender = core.normalizeEmail(message.from);
    const found = rules.filter(rule => rule.sender === sender && message.subject.includes(rule.subjectContains) && (rule.mode === 'reusable' || rule.messageId === message.id));
    return found.length === 1 ? { rule: found[0], issue: null } : { rule: null, issue: found.length ? '複数のルールに一致します' : '取込みパターンを教えてください' };
  }
  function parseBlock(text, rule) {
    const values = { client: rule.client }, issues = [];
    for (const [field, label] of Object.entries(rule.mapping)) {
      const matches = text.split(/\r?\n/).map(line => line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/)).filter(match => match && match[1].trim() === label);
      if (matches.length > 1) { issues.push(label + 'が複数あります'); continue; }
      if (matches.length === 1) values[field] = matches[0][2];
    }
    if (values.day) { try { date(values.day); } catch (error) { issues.push(error.message); } }
    if (values.days !== undefined) {
      values.days = values.days.split(/[,、]/).map(day => day.trim());
      try {
        values.days.forEach(date);
        ensure(new Set(values.days).size === values.days.length, '実施日一覧が重複しています');
        ensure(!values.day || values.days.includes(values.day), '実施日と日程一覧が一致しません');
        values.day = values.days[0];
      } catch (error) { issues.push(error.message); }
    }
    if (values.headcount !== undefined) {
      const count = String(values.headcount).normalize('NFKC').match(/^(\d+)(?:名|人)?$/);
      if (!count || Number(count[1]) < 1 || Number(count[1]) > 100) issues.push('人数を1〜100名の整数で確認してください');
      else values.headcount = Number(count[1]);
    }
    if (values.bill !== undefined) {
      if (!/^\d+$/.test(values.bill) || !Number.isSafeInteger(Number(values.bill))) issues.push('請求額を円単位で確認してください');
      else values.bill = Number(values.bill);
    }
    // 別名の時間や自由文を「記載なし」と誤認して既定時刻へ変換しない。
    const labels = Object.values(rule.mapping);
    const unknownLines = text.split(/\r?\n/).filter(line => line.trim()).filter(line => {
      const match = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/);
      return !match || !labels.includes(match[1].trim());
    });
    if (unknownLines.length) issues.push('未登録の表現があります。パターンを確認してください');
    const timeMissing = values.time === undefined || values.time === '';
    const arrivalMissing = values.plannedArrival === undefined || values.plannedArrival === '';
    const timing = business.resolveTime(values);
    issues.push(...timing.issues);
    if (!timing.issues.length) {
      values.time = timing.time; values.plannedArrival = timing.plannedArrival;
      values.timePlanned = timing.planned;
      values.inferredFields = [...(timeMissing ? ['time', 'timePlanned'] : []), ...(arrivalMissing ? ['plannedArrival'] : [])];
    }
    REQUIRED.forEach(field => { if (!values[field]) issues.push(({ day: '実施日', client: '取引先', store: '店舗', time: '実施時間' }[field]) + 'が不明です'); });
    if (values.client !== rule.client) issues.push('適用ルールの取引先と異なります');
    return { values, issues };
  }
  function instant(value, label) {
    // null→1970年、タイムゾーン未指定→端末時刻、存在しない日→翌月への補正を許さない。
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    ensure(match, label + 'をタイムゾーン付きの日時で指定してください');
    const day = Date.parse(match[1] + 'T00:00:00Z'), stamp = Date.parse(value);
    ensure(Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === match[1] && Number.isFinite(stamp), label + 'に存在しない日時が指定されています');
    return stamp;
  }
  function analyze(message, rules, { startedAt, processedIds = [] } = {}) {
    ensure(typeof message?.id === 'string' && message.id.trim() && message.id === message.id.trim() && !/[\r\n]/.test(message.id) && typeof message.subject === 'string' && typeof message.body === 'string', '元メールの識別情報・本文が必要です');
    const start = instant(startedAt, '運用開始日時'), received = instant(message.receivedAt, '受信日時');
    ensure(Array.isArray(processedIds) && processedIds.every(id => typeof id === 'string' && id.trim()), '取込み済みメールIDの一覧が不正です');
    if (processedIds.includes(message.id)) return { messageId: message.id, state: 'ALREADY_PROCESSED', candidates: [] };
    if (received < start) return { messageId: message.id, state: 'BEFORE_START', candidates: [] };
    ensure(Array.isArray(message.to), '受信先アドレスの一覧が必要です');
    const to = message.to.map(core.normalizeEmail);
    if (!to.includes('info@lipknots.com')) return { messageId: message.id, state: 'NOT_CLIENT_INBOX', candidates: [] };
    const matched = selectRule(message, rules);
    if (!matched.rule) return { messageId: message.id, state: 'REVIEW', issues: [matched.issue], candidates: [] };
    const rule = matched.rule;
    // 初期パーサーは明示した「---」区切りの項目形式のみ。
    // 添付・引用返信・自由文・キャンセル文は勝手に新規依頼へ変換しない。
    const issues = [];
    if (message.attachments?.length) issues.push('添付内容との照合は未実装です');
    if (/キャンセル|中止|取消/.test(message.subject + '\n' + message.body)) issues.push('キャンセル依頼は対象確認が必要です');
    if (/変更|訂正|修正|差替|差し替え/.test(message.subject + '\n' + message.body)) issues.push('変更依頼は対象案件の確認が必要です');
    if (/^\s*>|転送メッセージ|Original Message|wrote:/m.test(message.body)) issues.push('引用・転送部分の区別が必要です');
    const candidates = message.body.split(/^\s*---\s*$/m).filter(block => block.trim()).map((block, index) => {
      const parsed = parseBlock(block, rule);
      return { candidateId: JSON.stringify([message.id, index]), source: { messageId: message.id, part: 'body', index, ruleId: rule.id, ruleVersion: rule.version }, ...parsed };
    });
    if (!candidates.length) issues.push('案件がありません');
    const partial = candidates.some(candidate => candidate.issues.length) && candidates.some(candidate => !candidate.issues.length);
    if (partial) issues.push('一部取込みの扱いは未回答です');
    return { messageId: message.id, state: issues.length || candidates.some(candidate => candidate.issues.length) ? 'REVIEW' : 'CANDIDATES_READY', candidates, issues, rule: { id: rule.id, version: rule.version } };
  }
  function changeProposal(existing, candidate) {
    ensure(existing.id && candidate.source?.messageId, '固定案件IDと元メールが必要です');
    ensure(!candidate.issues?.length, '不明な内容を解決してください');
    // スタッフ名・給与等の支払額はメールによる上書き対象にしない。
    const changes = EDITABLE.filter(field => !candidate.values.inferredFields?.includes(field) && candidate.values[field] !== undefined && candidate.values[field] !== (field === 'timePlanned' ? Boolean(existing[field]) : existing[field])).map(field => ({ field, before: existing[field] ?? null, after: candidate.values[field] }));
    if (changes.some(change => change.field === 'time') && candidate.values.inferredFields?.includes('plannedArrival') && existing.plannedArrival) {
      const timing = business.resolveTime({ client: candidate.values.client || existing.client, time: candidate.values.time, plannedArrival: existing.plannedArrival });
      ensure(!timing.issues.length, '既存の入店時刻と変更後の実施時間が整合しません。入店時刻を確認してください');
    }
    const effects = existing.billingState === 'CONFIRMED' && changes.some(change => change.field === 'bill') ? ['請求単価が変わるため、以前の金額の確認根拠は履歴へ残し、新しい単価は確認待ちに戻します。'] : [];
    return { caseId: existing.id, source: clone(candidate.source), state: 'REVIEW', changes, effects, snapshot: canonical(existing) };
  }
  function applyChange(existing, proposal, approval) {
    ensure(approval?.confirmed === true && approval?.actor && approval?.at, '社長の確認操作が必要です');
    ensure(existing.id === proposal.caseId && canonical(existing) === proposal.snapshot, '確認後に案件が変更されています');
    ensure(proposal.state === 'REVIEW', '確認待ちの変更案ではありません');
    const next = clone(existing);
    proposal.changes.forEach(change => {
      ensure(EDITABLE.includes(change.field), 'メールから変更できない項目です');
      next[change.field] = clone(change.after);
    });
    if (proposal.changes.some(change => change.field === 'store')) { next.location = null; next.locationReviewReason = '店舗変更後の所在地を確認してください'; }
    const event = { caseId: existing.id, source: clone(proposal.source), changes: clone(proposal.changes), approval: clone(approval), state: 'APPLIED', effects: clone(proposal.effects || []) };
    if (existing.billingState === 'CONFIRMED' && proposal.changes.some(change => change.field === 'bill')) {
      if (existing.billingConfirmation) event.previousBillingConfirmation = clone(existing.billingConfirmation);
      next.billingState = 'REVIEW'; delete next.billingConfirmation;
    }
    return { row: next, event };
  }
  return { EDITABLE, IMPORT_FIELDS, REQUIRED, newRule, selectRule, parseBlock, instant, analyze, changeProposal, applyChange };
})();
if (typeof module !== 'undefined') module.exports = LKIntake;
