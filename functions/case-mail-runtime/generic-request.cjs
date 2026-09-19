'use strict';
const core = require('./core.js');
const business = require('./business-rules.js');
const shift = require('./shift-adapter.js');
const mail = require('./mail-source.cjs');

const LABELS = Object.freeze({
  day: ['実施日', '勤務日', '日付'],
  client: ['クライアント', '取引先', '依頼元'],
  store: ['店舗', '店舗名', '勤務先'],
  maker: ['メーカー', '商品メーカー'],
  product: ['メニュー', '業務内容', '商品・業務内容'],
  plannedArrival: ['入店時間', '入店時刻'],
  time: ['実施時間', '勤務時間'],
  headcount: ['人数', '必要人数', '募集人数'],
  bill: ['請求単価', '請求額'],
  memo: ['備考', '注意事項']
});
const BY_LABEL = new Map(Object.entries(LABELS).flatMap(([field, labels]) => labels.map(label => [label, field])));
const REQUIRED = ['day', 'client', 'store', 'maker', 'product', 'plannedArrival', 'time', 'headcount'];
const AEON_HEADERS = ['ライン番号', '案件番号', '発注番号', '発注日', '発注額', 'エリア', '都道府県', '店舗番号', '店舗名', '展開外',
  'デモ日', 'メーカー名', '商品名', 'デモ実施場所', '勤務開始時間', '勤務終了時間', '調理有無', '電気備品', '試食有無', '写真必須',
  '必須研修', '性別', 'セールス備考', '●協力会社名', '実働時間', '基本料金', '交通費', '遠隔地', '繁忙日加算', '検便検査費',
  '通信費', '書類発送費', '他請求科目1', '他請求費用1', '他請求科目2', '他請求費用2', '他請求科目3', '他請求費用3',
  '●手配可否', '常時使用する従業員100人以下(個人を含む)', '自社スタッフor協力会社', '案件受領確認者名', '受領確認日', '依頼変更', '備考'];
const AEON_REQUIRED = ['ライン番号', '案件番号', '店舗名', 'デモ日', 'メーカー名', '商品名', '勤務開始時間', '勤務終了時間'];
const clean = text => String(text ?? '').normalize('NFKC').trim();
function verifiedAttachmentCover(text, subject = '') {
  const body = String(text ?? '').normalize('NFKC'), value = body + '\n' + String(subject ?? '').normalize('NFKC');
  if (!/(?:添付|発注書|依頼書|スケジュール|シフト表)/.test(body)) return false;
  if (/(?:取消|中止|キャンセル|変更|訂正|修正|差替|差し替え|追加)/.test(value)) return false;
  const labels = Object.values(LABELS).flat().map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const condition = new RegExp('(?:^|\\n)\\s*(?:' + labels + ')\\s*[:：\\t]', 'm');
  if (condition.test(value)) return false;
  if (/(?:^|\n)\s*[※＊*・●○★☆\s]*\d{1,3}\s*(?:名|人)\s*募集(?:です)?[。！!\s]*(?:\n|$)/m.test(value)) return false;
  if (/(?:^|[^\d])20\d{2}\s*(?:年|[\/.\-])\s*\d{1,2}\s*(?:月|[\/.\-])\s*\d{1,2}|(?:^|\s)\d{1,2}\s*[\/.]\s*\d{1,2}(?:\s|[（(]|$)|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}:\d{2}\s*[~〜～\-]\s*\d{1,2}:\d{2}|\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?\s*[~〜～\-]\s*\d{1,2}\s*時|\d[\d,，]*\s*円/.test(value)) return false;
  if (/(?:店舗|店舗名|メーカー|商品|メニュー|入店|勤務時間|実施時間)\s*(?:は|[:：])/.test(value)) return false;
  return true;
}

function parseFields(lines, source, message) {
  const values = {}, issues = [], seen = new Set();
  for (const raw of lines) {
    if (!clean(raw)) continue;
    const match = /^\s*([^:：\t]+?)\s*[:：\t]\s*(.*?)\s*$/.exec(String(raw));
    if (!match) {
      const recruitment = /^[※＊*・●○★☆\s]*(\d{1,3})\s*(?:名|人)\s*募集(?:です)?[。！!\s]*$/.exec(clean(raw));
      if (recruitment) {
        if (seen.has('headcount')) issues.push('同じ項目が複数あります：headcount');
        else { seen.add('headcount'); values.headcount = recruitment[1]; }
        continue;
      }
      issues.push('未読の依頼文があります'); continue;
    }
    const field = BY_LABEL.get(clean(match[1]));
    if (!field) { issues.push('未対応の項目があります：' + clean(match[1]).slice(0, 80)); continue; }
    if (seen.has(field)) { issues.push('同じ項目が複数あります：' + field); continue; }
    seen.add(field); values[field] = clean(match[2]);
  }
  if (!seen.has('headcount')) values.headcount = 1;
  for (const field of REQUIRED) if (!values[field]) issues.push(field + 'が不明です');
  if (values.day) {
    try { values.day = shift.dateValue(values.day); if (values.day < '2026-10-01') issues.push('2026年10月より前の案件です'); }
    catch (error) { issues.push(error.message); }
  }
  if (values.headcount) {
    const count = /^(\d+)(?:人|名)?$/.exec(values.headcount);
    if (!count || !Number.isSafeInteger(Number(count[1])) || Number(count[1]) < 1 || Number(count[1]) > 100) issues.push('人数を1〜100名で確認してください');
    else values.headcount = Number(count[1]);
  }
  if (values.bill !== undefined) {
    const amount = values.bill.replace(/[,，円\s]/g, '');
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) issues.push('請求単価を円単位で確認してください');
    else values.bill = Number(amount);
  }
  if (values.time && values.plannedArrival) {
    const timing = business.resolveTime(values);
    issues.push(...timing.issues);
    if (!timing.issues.length) {
      // 取引先固有の時刻変換が入る場合は、原文との関係を自動確定しない。
      if (timing.notes.length) issues.push('時刻の変換根拠を確認してください');
      values.time = timing.time; values.plannedArrival = timing.plannedArrival;
      values.timePlanned = timing.planned;
    }
  }
  for (const field of ['client', 'store', 'maker', 'product']) {
    if (values[field] && (values[field].length > 2000 || /未定|調整|別途/.test(values[field]))) issues.push(field + 'の記載を確認してください');
  }
  return { candidateId: core.canonical([message.id, source.part, source.index]), source, values,
    issues: [...new Set(issues)] };
}

function parseText(text, source, message) {
  const blocks = String(text).split(/^\s*---\s*$/m).filter(block => clean(block));
  return blocks.map((block, index) => parseFields(block.split(/\r?\n/), { ...source, index }, message));
}

function position(items, start, message) {
  return items.map((item, offset) => {
    const source = { ...item.source, index: start + offset };
    return { ...item, source, candidateId: core.canonical([message.id, source.part, source.index]) };
  });
}

function parseWorkbook(extraction, source, message) {
  core.ensure(extraction?.format === 'xlsx' && extraction.complete === true && Array.isArray(extraction.sheets), 'Excelの全シートを取得してください');
  const candidates = [], issues = [];
  for (const sheet of extraction.sheets) {
    if (!Array.isArray(sheet.rows) || !sheet.rows.length) { issues.push('空のシートがあります：' + clean(sheet.name)); continue; }
    const header = sheet.rows[0];
    if (!Array.isArray(header) || new Set(header.map(clean).filter(Boolean)).size !== header.map(clean).filter(Boolean).length) { issues.push('Excel見出しが重複または不正です：' + clean(sheet.name)); continue; }
    for (let rowNumber = 2; rowNumber <= sheet.rows.length; rowNumber++) {
      const row = sheet.rows[rowNumber - 1];
      if (!Array.isArray(row) || !row.some(value => clean(value))) continue;
      if (row.length > header.length && row.slice(header.length).some(value => clean(value))) { issues.push('見出しのないExcel列があります：' + clean(sheet.name) + ' ' + rowNumber + '行'); continue; }
      const lines = header.map((label, index) => clean(row[index]) ? clean(label) + '：' + clean(row[index]) : '');
      candidates.push(parseFields(lines, { ...source, index: candidates.length, sheet: sheet.name, rowNumber }, message));
    }
  }
  return { candidates, issues };
}

function parseAeonWorkbook(extraction, source, message) {
  core.ensure(extraction?.format === 'xlsx' && extraction.complete === true && Array.isArray(extraction.sheets), 'イオン発注書の全シートを取得してください');
  const candidates = [], issues = [], lineNumbers = new Set();
  for (const sheet of extraction.sheets) {
    if (!Array.isArray(sheet.rows) || !sheet.rows.every(Array.isArray)) { issues.push('発注書の行構造を確認できません'); continue; }
    if (sheet.name !== '依頼表') { if (sheet.rows?.some(row => row.some(value => clean(value)))) issues.push('未対応の発注書シートがあります：' + clean(sheet.name)); continue; }
    const matches = sheet.rows.map((row, index) => ({ row: row.map(clean), index })).filter(item => AEON_REQUIRED.every(label => item.row.includes(label)));
    if (matches.length !== 1) { issues.push('依頼表の見出しを一意に確認できません'); continue; }
    const { row: header, index: headerIndex } = matches[0];
    if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length) { issues.push('依頼表に重複した見出しがあります'); continue; }
    const unknownHeaders = header.filter(label => label && !AEON_HEADERS.includes(label));
    const preambleRules = new Map([
      ['●手配可否', /^(?:可\s*\/\s*否)?$/],
      ['常時使用する従業員100人以下(個人を含む)', /^(?:100名以下:はい、101名以上:いいえ)?$/],
      ['自社スタッフor協力会社', /^(?:自社スタッフ\s*\/\s*協力会社)?$/],
      ['案件受領確認者名', /^(?:ご手配担当者名)?$/],
      ['受領確認日', /^(?:ご回答日\(例:20\d{2}\/\d{1,2}\/\d{1,2}\))?$/]
    ]);
    const preambleAllowed = new Set([0, ...[...preambleRules.keys()].map(label => header.indexOf(label)).filter(index => index >= 0)]);
    const preambleInvalid = sheet.rows.slice(0, headerIndex).some(row => row.some((raw, column) => {
      const item = clean(raw); if (!item) return false;
      if (!preambleAllowed.has(column)) return true;
      if (column === 0) return !/(?:役務内容|発注条件)/.test(item);
      return !preambleRules.get(header[column]).test(item);
    }));
    if (preambleInvalid) { issues.push('依頼表の見出し前の説明欄を確認できません'); continue; }
    const indexOf = label => header.indexOf(label), value = (row, label) => clean(row[indexOf(label)]);
    for (let rowIndex = headerIndex + 1; rowIndex < sheet.rows.length; rowIndex++) {
      const row = sheet.rows[rowIndex]; if (!row.some(item => clean(item))) continue;
      const line = value(row, 'ライン番号');
      if (!line || lineNumbers.has(line)) { issues.push('発注書のライン番号が空欄または重複しています：' + (rowIndex + 1) + '行'); continue; }
      lineNumbers.add(line);
      const arrangement = value(row, '●手配可否');
      if (arrangement) {
        if (!/^(?:可|否)$/.test(arrangement)) issues.push('手配可否の回答を確認してください：' + (rowIndex + 1) + '行');
        continue; // 返信済みの旧行を新着案件として再登録しない。
      }
      const entryIssues = [], values = { client: 'イオンデモ', store: value(row, '店舗名'), maker: value(row, 'メーカー名'), product: value(row, '商品名'), headcount: 1 };
      try { values.day = shift.dateValue(value(row, 'デモ日')); if (values.day < '2026-10-01') entryIssues.push('2026年10月より前の案件です'); }
      catch (error) { entryIssues.push(error.message); }
      const start = value(row, '勤務開始時間').replace(/^(\d{1,2}:\d{2}):00$/, '$1');
      const end = value(row, '勤務終了時間').replace(/^(\d{1,2}:\d{2}):00$/, '$1');
      if (start && end) {
        const timing = business.resolveTime({ client: values.client, time: start + '～' + end });
        entryIssues.push(...timing.issues);
        if (!timing.issues.length) { values.time = timing.time; values.plannedArrival = timing.plannedArrival; }
      } else entryIssues.push('勤務時間の開始・終了が不明です');
      if (!values.store || !values.maker || !values.product) entryIssues.push('店舗・メーカー・商品名が不明です');
      if (/未定|調整|別途/.test(values.product)) entryIssues.push('商品名・業務内容が未確定です');
      if (unknownHeaders.length) entryIssues.push('未対応の発注書列があります：' + unknownHeaders.join('、').slice(0, 200));
      if (value(row, '展開外')) entryIssues.push('展開外の案件として扱うか確認してください');
      if (value(row, '依頼変更')) entryIssues.push('発注書の依頼変更欄を確認してください：' + value(row, '依頼変更'));
      const instructions = ['デモ実施場所', '調理有無', '電気備品', '試食有無', '写真必須', '必須研修', '性別', 'セールス備考', '備考']
        .filter(label => header.includes(label) && value(row, label)).map(label => label + '：' + value(row, label));
      if (instructions.length) values.memo = instructions.join('／');
      const excerpt = header.map((label, column) => label && clean(row[column]) ? label + '：' + clean(row[column]) : '').filter(Boolean).join('\n');
      const candidateSource = { ...source, index: candidates.length, sheet: sheet.name, rowNumber: rowIndex + 1,
        ruleId: 'aeon-order-xlsx-v1', ruleVersion: 1, externalLineId: line, excerpt };
      candidates.push({ candidateId: core.canonical([message.id, candidateSource.part, candidateSource.index]), source: candidateSource,
        values, issues: [...new Set(entryIssues)] });
    }
  }
  return { candidates, issues };
}

function analyze(message, documents = [], options = {}) {
  const eligibility = mail.gate(message, options);
  if (eligibility !== 'ELIGIBLE') return { messageId: message.id, state: eligibility, candidates: [], issues: [] };
  core.ensure(Array.isArray(documents), '添付の抽出結果が不正です');
  const issues = [...message.issues], candidates = [];
  let structuralComplete = true;
  if (/取消|中止|キャンセル|変更|訂正|修正|差替|差し替え|追加/.test(message.subject + '\n' + message.body)) issues.push('新規依頼か変更・取消か確認してください');
  if (message.body.trim() && !message.attachments.length) candidates.push(...parseText(message.body, { messageId: message.id, part: 'body', ruleId: 'generic-explicit-v1', ruleVersion: 1 }, message));
  for (const attachment of message.attachments) {
    const found = documents.filter(item => item.partId === attachment.partId);
    if (found.length !== 1 || found[0].extraction?.sha256 !== found[0].sha256 || found[0].sha256 !== attachment.sha256 || found[0].extraction.bytes !== attachment.size) {
      structuralComplete = false; issues.push('添付の取得・抽出結果が不完全です：' + attachment.filename); continue;
    }
    const extraction = found[0].extraction;
    const source = { messageId: message.id, part: 'attachment:' + attachment.partId, attachmentSha256: attachment.sha256,
      filename: attachment.filename, ruleId: 'generic-explicit-v1', ruleVersion: 1 };
    if (extraction.format === 'pdf' && extraction.complete === true && Array.isArray(extraction.pages) && extraction.pages.length === extraction.pageCount && extraction.pages.length > 0 && extraction.pages.every((page, index) => page.number === index + 1 && typeof page.text === 'string' && page.text.trim())) {
      let nextIndex = 0;
      for (const page of extraction.pages) {
        const parsed = parseText(page.text, { ...source, page: page.number }, message);
        candidates.push(...position(parsed, nextIndex, message)); nextIndex += parsed.length;
      }
    } else if (extraction.format === 'xlsx' && extraction.complete === true) {
      const parsed = message.from.endsWith('@aeondemos.com') ? parseAeonWorkbook(extraction, source, message) : parseWorkbook(extraction, source, message);
      candidates.push(...parsed.candidates); issues.push(...parsed.issues);
    } else { structuralComplete = false; issues.push('未対応の添付形式です：' + attachment.filename); }
  }
  if (message.body.trim() && message.attachments.length && !verifiedAttachmentCover(message.body, message.subject)) issues.push('本文と添付の案件・条件を照合してください');
  if (!candidates.length) issues.push('案件を読み取れていません');
  return { messageId: message.id, sourceFingerprint: message.fingerprint, structuralComplete,
    state: issues.length || candidates.some(candidate => candidate.issues.length) ? 'REVIEW' : 'CANDIDATES_READY',
    candidates, issues: [...new Set(issues)], rule: { id: 'generic-explicit-v1', version: 1 } };
}

module.exports = { LABELS, verifiedAttachmentCover, parseFields, parseText, parseWorkbook, parseAeonWorkbook, analyze };
