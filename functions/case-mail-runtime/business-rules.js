'use strict';
const LKBusiness = (() => {
  const c = typeof module !== 'undefined' ? require('./core.js') : LKCase;
  const missing = value => value === undefined || value === null || value === '';
  const yen = value => Number(value).toLocaleString('ja-JP') + '円';
  function clock(value) {
    const text = String(value).normalize('NFKC').replace(/\s/g, '');
    const match = /^([01]?\d|2[0-3])(?::([0-5]\d))?$/.exec(text);
    c.ensure(match, '時刻を確認してください：' + value);
    return Number(match[1]) * 60 + Number(match[2] || 0);
  }
  function displayClock(minutes) { return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'); }
  function range(value) {
    const text = String(value).normalize('NFKC').replace(/\s/g, '').replace(/[～〜~‐‑‒–—―−ー]/g, '-').replace(/[（(]予定[）)]$/, '');
    const parts = text.split('-');
    c.ensure(parts.length === 2, '実施時間の開始と終了が不明です');
    const start = clock(parts[0]), end = clock(parts[1]);
    c.ensure(end > start, '日またぎ・終了が開始以前の時間は確認が必要です');
    return { start, end, minutes: end - start };
  }
  function resolveTime({ client, time, plannedArrival }) {
    const issues = [], notes = [], defaulted = missing(time);
    let span, arrival, planned = defaulted || /[（(]予定[）)]/.test(String(time));
    try {
      span = defaulted ? { start: 600, end: 1080, minutes: 480 } : range(time);
      if (defaulted) notes.push('実施時間未記載のため10:00〜18:00（予定）');
      if (span.start === 570 && span.end === 1080) {
        if (['プログレス', 'プロクラン'].includes(client)) { span = { start: 600, end: 1080, minutes: 480 }; notes.push('取引先の既決ルール：入店9:30、実施10:00〜18:00'); }
        else issues.push('9:30が実施開始か入店時刻かを元メールで確認してください');
      } else if (span.start === 570) issues.push('9:30の時間区分を元メールで確認してください');
      arrival = missing(plannedArrival) ? span.start - 30 : clock(plannedArrival);
      c.ensure(arrival >= 0 && arrival <= span.start, '入店時刻と実施開始の前後関係を確認してください');
      if (missing(plannedArrival)) notes.push('入店未記載のため実施開始30分前');
    } catch (error) { issues.push(error.message); }
    return { issues, notes, time: span ? displayClock(span.start) + '～' + displayClock(span.end) : null, plannedArrival: arrival === undefined ? null : displayClock(arrival), planned, minutes: span?.minutes ?? null };
  }
  function isStandby(row) { return row.client === 'リップノッツ' && row.product === '待機スタッフ' && row.store === '自宅'; }
  function standby(day) {
    c.date(day);
    return { day, client: 'リップノッツ', store: '自宅', maker: 'ー', product: '待機スタッフ', plannedArrival: '07:00', time: '08:00～11:00', bill: 0, salary: 4000, allowance: 0, jobType: 'standby' };
  }
  function basePay(row) {
    if (c.cancelled(row)) return { state: 'MANUAL', salary: null, allowance: null, total: null, reason: 'キャンセル時は社長が決定' };
    if (row.dispatch?.confirmed === true) return { state: 'CALCULATED', salary: 12000, allowance: 2000, total: 14000, reason: '待機からの現場出動' };
    if (isStandby(row)) return { state: 'CALCULATED', salary: 4000, allowance: 0, total: 4000, reason: '待機' };
    const span = range(row.time);
    if (span.minutes < 360) return { state: 'CALCULATED', salary: 5000, allowance: 2000, total: 7000, reason: '6時間未満' };
    // 通常の既存個別条件は保持。未確認の単価を新しく作らない。
    if (!missing(row.salary) && !missing(row.allowance)) {
      c.ensure(Number.isSafeInteger(row.salary) && row.salary >= 0 && Number.isSafeInteger(row.allowance) && row.allowance >= 0, '支払額を確認してください');
      return { state: 'EXISTING', salary: row.salary, allowance: row.allowance, total: row.salary + row.allowance, reason: 'シフトの既存金額' };
    }
    return { state: 'REVIEW', salary: null, allowance: null, total: null, reason: '通常案件の給与条件を照合してください' };
  }
  function dispatchProposal(row, actual) {
    c.ensure(isStandby(row) && !c.cancelled(row), '待機中の有効案件を選んでください');
    c.ensure(typeof row.id === 'string' && row.id.trim(), '待機案件の固定IDが必要です'); c.date(row.day);
    ['client', 'store', 'maker', 'product', 'time', 'plannedArrival'].forEach(field => c.ensure(typeof actual?.[field] === 'string' && actual[field].trim(), '出動先の' + field + 'が必要です'));
    const timing = resolveTime(actual);
    c.ensure(!timing.issues.length, timing.issues.join('／'));
    const after = { ...c.clone(row), ...Object.fromEntries(['client', 'store', 'maker', 'product'].map(field => [field, actual[field]])), time: timing.time, plannedArrival: timing.plannedArrival, timePlanned: timing.planned, salary: 12000, allowance: 2000, jobType: 'dispatch', dispatch: { confirmed: true }, salaryHighlight: 'attention' };
    c.ensure(!isStandby(after), '出動先が待機案件のままです。実際の勤務先を確認してください');
    // 自宅待機の所在地を、新しい勤務先の確認済み所在地として流用しない。
    after.location = null; after.locationReviewReason = '現場出動後の店舗所在地を確認してください';
    // 待機の請求0円を出動先の確定単価として引き継がない。
    if (missing(actual.bill)) { after.bill = null; after.billingState = 'REVIEW'; }
    else { c.ensure(Number.isSafeInteger(actual.bill) && actual.bill >= 0, '出動先の請求額を確認してください'); after.bill = actual.bill; after.billingState = 'CONFIRMED'; }
    return { caseId: row.id, before: c.clone(row), after, snapshot: c.canonical(row), state: 'REVIEW' };
  }
  function applyDispatch(row, proposal, approval) {
    c.ensure(approval?.actor && approval?.at && approval?.confirmed === true, '社長の出動確認が必要です');
    c.ensure(row.id === proposal.caseId && c.canonical(row) === proposal.snapshot, '確認中に待機案件が変わりました');
    return { ...c.clone(proposal.after), dispatch: { confirmed: true, ...c.clone(approval) } };
  }
  function recruitmentView(row) {
    c.ensure(!c.cancelled(row), 'キャンセル案件は募集できません');
    const standbyCase = isStandby(row), span = range(row.time);
    const title = standbyCase ? '※Lip Knots　待機スタッフ' : [!missing(row.maker) && row.maker !== 'ー' ? row.maker : '', row.product || ''].filter(Boolean).join('　');
    const handouts = [];
    [['payDistance', '遠方手当'], ['payEmergency', '緊急手当']].forEach(([field, label]) => {
      if (missing(row[field]) || row[field] === 0) return;
      c.ensure(Number.isSafeInteger(row[field]) && row[field] > 0, label + 'の金額を確認してください');
      handouts.push({ field, amount: row[field], text: '★' + label + yen(row[field]) });
    });
    return { day: row.day, title, store: standbyCase ? '' : row.store, time: displayClock(span.start) + '～' + displayClock(span.end) + (row.timePlanned ? '（予定）' : ''), supplements: handouts, pay: basePay(row) };
  }
  return { clock, displayClock, range, resolveTime, isStandby, standby, basePay, dispatchProposal, applyDispatch, recruitmentView };
})();
if (typeof module !== 'undefined') module.exports = LKBusiness;
