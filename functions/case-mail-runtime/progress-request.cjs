'use strict';
const c = require('./core.js'), business = require('./business-rules.js'), mail = require('./mail-source.cjs');
const RULE = 'progress-schedule-pdf-v1', norm = s => s.normalize('NFKC');
function verifiedCover(body) {
  // 実メールで確認した定型の依頼文だけを、添付内容と競合しない表紙として扱う。
  // 返信履歴や署名に案件条件があっても、今回の依頼条件とは解釈しない。
  const current = norm(String(body || '')).split(/^From:/m)[0].split(/^■-□/m)[0];
  const lines = current.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return c.canonical(lines) === c.canonical([
    '花野様', 'いつも大変お世話になっております。',
    '表題の件、ご手配お願い出来ますでしょうか。',
    '※弊社でも並行してあたっております。',
    'ご検討の程、何卒宜しくお願い致します。'
  ]);
}
function lines(words) {
  const groups = [];
  for (const w of [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0)) {
    let g = groups.find(g => Math.abs(g.top - w.top) < 2);
    if (!g) { g = { top: w.top, words: [] }; groups.push(g); } g.words.push(w);
  }
  return groups.map(g => g.words.sort((a, b) => a.x0 - b.x0).map(w => norm(w.text)).join(' '));
}
function parsePdf(extraction, message, attachment) {
  c.ensure(extraction?.version === 1 && extraction.format === 'pdf' && /^[a-f0-9]{64}$/.test(extraction.sha256), 'PDF抽出の出典が不正です');
  c.ensure(extraction.complete === true && extraction.pageCount === extraction.pages?.length && extraction.pages.length > 0, 'PDFの全文取得が未完了です');
  c.ensure(extraction.bytes === attachment.size, '元添付とPDFのサイズが一致しません');
  const candidates = [], issues = [];
  for (const [pageIndex, page] of extraction.pages.entries()) {
    c.ensure(page.number === pageIndex + 1 && page.text && Array.isArray(page.words), 'PDFのページが重複・欠落しています');
    c.ensure(page.words.every(w => typeof w.text === 'string' && [w.x0, w.x1, w.top, w.bottom].every(Number.isFinite)), 'PDF内の文字位置を確認してください');
    c.ensure(/スケジュール連絡表/.test(page.text) && /プログレスホールディングス/.test(norm(page.text)), 'プログレスの確認済み書式と一致しません');
    const starts = page.words.filter(w => norm(w.text).startsWith('[開始]')).sort((a, b) => a.top - b.top);
    c.ensure(starts.length > 0 && starts.length <= 3, 'PDFの案件区切りを確認してください');
    for (let blockIndex = 0; blockIndex < starts.length; blockIndex++) {
      const top = starts[blockIndex].top, bottom = starts[blockIndex + 1]?.top ?? page.height;
      const words = page.words.filter(w => w.top >= top - 1 && w.top < bottom - 1);
      const anchors = label => words.filter(w => norm(w.text).startsWith(label));
      const stores = anchors('[ストア店名]'), makers = anchors('[メーカー]'), equipment = anchors('[器材]');
      c.ensure(stores.length === 1 && makers.length === 1 && equipment.length === 1 && starts[blockIndex].x0 < stores[0].x0 && stores[0].x0 < makers[0].x0 && makers[0].x0 < equipment[0].x0, 'PDFの列構造が変更されています');
      const left = lines(words.filter(w => w.x0 < stores[0].x0 - 1));
      const center = lines(words.filter(w => w.x0 >= stores[0].x0 - 1 && w.x0 < makers[0].x0 - 1));
      const product = lines(words.filter(w => w.x0 >= makers[0].x0 - 1 && w.x0 < equipment[0].x0 - 1));
      const entryIssues = [], read = (values, label) => {
        const found = values.filter(line => line.startsWith(label));
        if (found.length !== 1) { entryIssues.push(label + 'を一意に読めません'); return ''; }
        return found[0].slice(label.length).split(/\[[^\]]+\]/)[0].trim();
      };
      const parseDate = label => { const value = read(left, label), m = /^(\d{2})\/(\d{2})\/(\d{2})\([日月火水木金土]\)$/.exec(value); if (!m) { entryIssues.push(label + 'の日付書式を確認してください'); return ''; } const day = '20' + m[1] + '-' + m[2] + '-' + m[3]; try { c.date(day); } catch { entryIssues.push('存在しない実施日です'); } return day; };
      const day = parseDate('[開始]'), end = parseDate('[終了]');
      if (day !== end) entryIssues.push('複数日にまたがる依頼です。日別の条件を確認してください');
      const timeLines = left.filter(line => /^\[\d+日\]/.test(line));
      let timing = null, rawTime = '';
      if (timeLines.length !== 1) entryIssues.push('日別の実施時間を確認してください');
      else {
        const match = /^\[(\d+)日\]\s*(.*)$/.exec(timeLines[0]); rawTime = match[2];
        if (Number(match[1]) !== Number(day.slice(-2))) entryIssues.push('時刻欄の日付と開始日が違います');
        if (/注/.test(rawTime)) entryIssues.push('実施時間に注意指定があります');
        timing = business.resolveTime({ client: 'プログレス', time: rawTime.replace(/^注\s*/, '') }); entryIssues.push(...timing.issues);
      }
      const values = { day, client: 'プログレス', store: read(center, '[ストア店名]'), maker: read(product, '[メーカー]'), product: read(product, '[メニュー]'), headcount: 1 };
      if (/\d+\s*(?:名|人)(?!前)/.test(lines(words).join('\n'))) entryIssues.push('人数の明示があります。人数枠を確認してください');
      if (timing && !timing.issues.length) Object.assign(values, { time: timing.time, plannedArrival: timing.plannedArrival, timePlanned: timing.planned });
      if (!values.store || !values.maker || !values.product) entryIssues.push('店舗・メーカー・メニューに未読項目があります');
      if (/未定|予定|調整|別途/.test(values.product)) entryIssues.push('メニューが未確定です');
      if (day < '2026-10-01') entryIssues.push('本番適用開始月より前の案件です');
      const source = { messageId: message.id, part: 'attachment:' + attachment.partId, index: candidates.length, ruleId: RULE, ruleVersion: 1,
        attachmentSha256: extraction.sha256, filename: attachment.filename, page: page.number, block: blockIndex + 1, bounds: { top, bottom }, rawTime, excerpt: lines(words).join('\n') };
      candidates.push({ candidateId: c.canonical([message.id, source.part, source.index]), source, values, issues: [...new Set(entryIssues)] });
    }
  }
  return { candidates, issues, rule: { id: RULE, version: 1 } };
}
function analyze(message, extractions, options) {
  const gate = mail.gate(message, options);
  if (gate !== 'ELIGIBLE') return { messageId: message.id, state: gate, candidates: [], issues: [] };
  c.ensure(message.from.endsWith('@cs-progress.co.jp'), '依頼元がプログレスの確認対象と一致しません');
  const cover = verifiedCover(message.body);
  const issues = message.issues.filter(issue => !(cover && issue === '引用返信を含みます。今回の依頼範囲を確認してください'));
  const candidates = []; let structuralComplete = message.attachments.length > 0;
  if (!/手配依頼|案件依頼/.test(norm(message.subject))) issues.push('依頼メールの件名を確認してください');
  const currentBody = cover ? norm(message.body).split(/^From:/m)[0].split(/^■-□/m)[0] : message.body;
  if (/変更|訂正|取消|キャンセル|追加/.test(message.subject + '\n' + currentBody)) issues.push('追加・変更・取消の対象確認が必要です');
  if (!message.attachments.length) issues.push('依頼の添付がありません');
  for (const attachment of message.attachments) {
    const item = extractions.find(e => e.partId === attachment.partId);
    if (!item || extractions.filter(e => e.partId === attachment.partId).length !== 1) { structuralComplete = false; issues.push('添付の取得が未完了です：' + attachment.filename); continue; }
    try { candidates.push(...parsePdf(item.extraction, message, attachment).candidates); }
    catch (error) { structuralComplete = false; issues.push(attachment.filename + '：' + error.message); }
  }
  if (message.body.trim() && !cover) issues.push('本文の依頼条件と添付の内容を照合してください');
  if (!candidates.length) issues.push('案件を読み取れていません');
  return { messageId: message.id, sourceFingerprint: message.fingerprint, structuralComplete, state: issues.length || candidates.some(x => x.issues.length) ? 'REVIEW' : 'CANDIDATES_READY', candidates, issues, rule: { id: RULE, version: 1 } };
}
function analyzeRead(readResult, extractions, options) {
  c.ensure(readResult?.complete === true && Array.isArray(readResult.attachments), 'メールと添付の読取りを完了してください');
  for (const attachment of readResult.attachments) {
    const item = extractions.find(e => e.partId === attachment.partId);
    c.ensure(attachment.messageId === readResult.message.id && attachment.detected === 'pdf', '添付の実体が対応PDFではありません');
    c.ensure(item?.extraction?.sha256 === attachment.sha256 && item.extraction.bytes === attachment.bytes.length, '抽出結果と元添付の指紋が違います');
  }
  return analyze(readResult.message, extractions, options);
}
module.exports = { parsePdf, analyze, analyzeRead, RULE };
