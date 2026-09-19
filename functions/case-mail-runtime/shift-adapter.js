'use strict';
const LKShift = (() => {
  const c = typeof module !== 'undefined' ? require('./core.js') : LKCase;
  // 2026/9/13の実見出しに基づく位置。重複見出しをindexOfで選ばない。
  const FIELDS = Object.freeze({
    day: ['A', '実施日'], staffName: ['B', 'スタッフ名'], client: ['J', 'クライアント'], store: ['K', '店舗'],
    maker: ['L', 'メーカー'], product: ['M', 'メニュー'], plannedArrival: ['N', '入店時間'], time: ['O', '実施時間'], memo: ['P', '備考'],
    bill: ['S', '請求単価'], billOvertime: ['T', '残業'], billDistance: ['U', '遠方'], billEmergency: ['V', '緊急'], billOutdoor: ['W', '店外'], billBusy: ['X', '繁忙'], billInspection: ['Y', '検査'], billManagement: ['Z', '管理費'],
    salary: ['AB', '給与'], allowance: ['AC', '業務手当'], payOvertime: ['AD', '残業'], payDistance: ['AE', '遠方'], payEmergency: ['AF', '緊急'], payOutdoor: ['AG', '店外'], payBusy: ['AH', '繁忙'], payInspection: ['AI', '検査'], billCommunication: ['AN', '通信費（請）']
  });
  const index = letters => [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  function month(name) { const match = /^(20\d{2})\.(1[0-2]|[1-9])$/.exec(name); return match ? match[1] + '-' + match[2].padStart(2, '0') : null; }
  function readPlan(metadata, today) {
    c.date(today);
    c.ensure(metadata.properties?.timeZone === 'Asia/Tokyo', 'シフト表のタイムゾーンを確認してください');
    // 非表示タブも対象。今月より先を固定期限で打ち切らない。
    return metadata.sheets.map(s => s.properties).filter(p => p.sheetType === 'GRID' && month(p.title) && month(p.title) >= today.slice(0, 7)).sort((a, b) => month(a.title).localeCompare(month(b.title))).map(p => ({ sheetId: p.sheetId, name: p.title, rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount, hidden: p.hidden === true }));
  }
  function schema(headers) {
    const issues = [];
    Object.entries(FIELDS).forEach(([field, [column, label]]) => { if (headers[index(column)] !== label) issues.push(column + '列は「' + label + '」が必要です（' + field + '）'); });
    const ids = headers.map((label, i) => label === '連絡_固定案件ID' ? i : -1).filter(i => i >= 0);
    if (ids.length !== 1) issues.push('固定案件ID列が空欄または重複しています');
    c.ensure(!issues.length, issues.join('／'));
    return { idIndex: ids[0], fields: FIELDS };
  }
  function dateValue(value) {
    if (value instanceof Date) return c.jstDay(value);
    if (typeof value === 'number') {
      c.ensure(Number.isFinite(value), '日付の数値が不正です');
      return c.date(new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10));
    }
    const text = String(value ?? '').normalize('NFKC').trim();
    const match = /^(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?(?:\s*[（(][日月火水木金土][）)])?$/.exec(text);
    c.ensure(match, '実施日の年月日が不明です');
    return c.date(match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0'));
  }
  function normalize(snapshot, { locations = {}, cancelledIds = [], pendingIds = [], excludedIds = [] } = {}) {
    c.ensure(month(snapshot.name), '対象は月別シフトのタブです');
    c.ensure(Number.isInteger(snapshot.sheetId), 'シートIDが必要です');
    const mapping = schema(snapshot.headers), result = { rows: [], issues: [] };
    const seenRows = new Set();
    for (const raw of snapshot.rows) {
      c.ensure(Number.isInteger(raw.rowNumber) && raw.rowNumber >= 2 && !seenRows.has(raw.rowNumber), '行番号が不正または重複しています');
      seenRows.add(raw.rowNumber);
      const values = raw.values, read = field => values[index(FIELDS[field][0])] ?? '';
      const source = { sheetId: snapshot.sheetId, sheetName: snapshot.name, rowNumber: raw.rowNumber };
      const staffName = read('staffName'), nameText = String(staffName).normalize('NFKC').trim();
      if (/^(?:[（(]?\s*[+-]?\d+人\s*[）)]?|合計|小計|総計|人数|スタッフ名)$/.test(nameText)) continue;
      if (!read('day') && !read('client') && !read('store')) continue;
      let day;
      try { day = dateValue(read('day')); c.ensure(day.slice(0, 7) === month(snapshot.name), '実施日と月別タブが一致しません'); }
      catch (error) { result.issues.push({ ...source, reason: error.message }); continue; }
      const row = { kind: 'case', id: values[mapping.idIndex] ?? '', source, day, staffName, cells: {} };
      const validId = typeof row.id === 'string' && row.id.trim();
      if (!validId) result.issues.push({ ...source, reason: '固定案件IDが空欄または文字列ではありません' });
      Object.entries(FIELDS).forEach(([field, [column]]) => {
        if (field !== 'day' && field !== 'staffName') row[field] = read(field);
        const i = index(column);
        row.cells[field] = { value: values[i] ?? '', formula: raw.formulas?.[i] || '', background: raw.backgrounds?.[i] || '', note: raw.notes?.[i] || '', a1: column + raw.rowNumber };
      });
      // B/C/H/電話等の個人情報全体は複製しない。案件に必要な項目のみ。
      row.location = c.clone(validId && Object.prototype.hasOwnProperty.call(locations, row.id) ? locations[row.id] || null : null);
      row.cancelled = !!validId && cancelledIds.includes(row.id) || c.cancelled(row);
      row.reviewPending = !validId || pendingIds.includes(row.id);
      row.excluded = !!validId && excludedIds.includes(row.id) || /ラウンダー/.test([row.client, row.product, row.memo].join(' '));
      result.rows.push(row);
    }
    return result;
  }
  return { FIELDS, index, month, readPlan, schema, dateValue, normalize };
})();
if (typeof module !== 'undefined') module.exports = LKShift;
