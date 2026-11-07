'use strict';
// LK_TRANSFER_PLAN from V17/current bound-project HEAD, L73-L254.
// Full source SHA256: 3a5c927afa6f9ee51704c1226668c4f9fac679a5a431718a6e514a3658665887.
module.exports = (() => {
  const dayMillis = 86400000;
  const serialEpoch = Date.UTC(1899, 11, 30);
  const tokyoOffset = 9 * 3600000;
  const countPattern = /^="（"&\(COUNTIF\(\$?A\$?(\d+):\$?A\$?(\d+),\$?A\$?(\d+)\)-1\)&"人）"$/i;

  function requirePlan(ok, code, detail) {
    if (ok) return;
    const error = new Error(code);
    error.code = code;
    error.detail = detail || {};
    throw error;
  }

  function normalize(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim();
  }

  function dateKey(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return new Date(value.getTime() + tokyoOffset).toISOString().slice(0, 10);
    }
    if (Number.isInteger(value) && value > 0 && value < 2958466) {
      return new Date(serialEpoch + value * dayMillis).toISOString().slice(0, 10);
    }
    const match = /^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/.exec(normalize(value));
    if (!match) return null;
    const key = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    return date.toISOString().slice(0, 10) === key ? key : null;
  }

  function timeMinutes(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      const date = new Date(value.getTime() + tokyoOffset);
      return date.getUTCSeconds() || date.getUTCMilliseconds()
        ? null : date.getUTCHours() * 60 + date.getUTCMinutes();
    }
    if (typeof value === 'number' && value >= 0 && value < 1) {
      const fraction = value * 1440;
      const minute = Math.round(fraction);
      return minute < 1440 && Math.abs(fraction - minute) < 1e-6 ? minute : null;
    }
    const raw = normalize(value);
    const clock = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(raw) || /^(\d{1,2})時(?:(\d{1,2})分)?$/.exec(raw);
    const compact = /^(\d{1,2})(\d{2})$/.exec(raw);
    const parts = clock || compact;
    if (!parts) return null;
    const hour = Number(parts[1]);
    const minute = Number(parts[2] || 0);
    return hour < 24 && minute < 60 ? hour * 60 + minute : null;
  }

  function workTime(value) {
    const raw = normalize(value);
    const parts = raw.split(/\s*[~〜～\-–—]\s*/);
    const compact = /^(\d{3,4})(\d{4})$/.exec(raw);
    const times = parts.length === 2 ? parts : compact ? compact.slice(1) : [];
    if (times.length !== 2) return null;
    const [start, end] = times.map(timeMinutes);
    return start !== null && end !== null && start < end ? { start, end } : null;
  }

  function scanLayout(month, key) {
    const title = /^(20\d{2})\.(1[0-2]|[1-9])$/.exec(month?.title || '');
    requirePlan(title && `${title[1]}-${title[2].padStart(2, '0')}` === key?.slice(0, 7), 'MONTH_DATE_MISMATCH');
    requirePlan(Array.isArray(month.rows), 'MONTH_LAYOUT_UNAVAILABLE');
    const boundary = month.boundaryRow == null ? Infinity : month.boundaryRow;
    requirePlan(boundary === Infinity || Number.isInteger(boundary) && boundary >= 2, 'MONTH_DASHBOARD_BOUNDARY_UNVERIFIED');
    let previousRow = 1;
    let previousDate = '';
    const dated = [];
    for (const row of month.rows) {
      requirePlan(Number.isInteger(row.row) && row.row > previousRow, 'MONTH_ROW_ORDER_CHANGED');
      previousRow = row.row;
      if (row.row >= boundary) continue;
      const date = dateKey(row.date);
      requirePlan(date || !normalize(row.client), 'MONTHLY_ASSIGNMENT_DATE_UNVERIFIED', { row: row.row });
      if (!date) continue;
      if (date.slice(0, 7) !== key.slice(0, 7)) {
        requirePlan(date < `${key.slice(0, 7)}-01` && !previousDate, 'MONTH_DATE_OUTSIDE_OPERATIONAL_BLOCK', { row: row.row });
        continue;
      }
      requirePlan(date >= previousDate, 'MONTH_DATE_ORDER_CHANGED', { row: row.row });
      previousDate = date;
      dated.push({ ...row, date });
    }
    return { dated, boundary };
  }

  function readDay(dated, key) {
    const day = dated.filter(row => row.date === key);
    if (!day.length) return null;
    const totals = day.filter(row => !normalize(row.client) && /^\(-?\d+人\)$/.test(normalize(row.staff)));
    requirePlan(totals.length === 1 && day[day.length - 1].row === totals[0].row, 'DAILY_TOTAL_BOUNDARY_UNVERIFIED', { date: key });
    const total = totals[0];
    const match = countPattern.exec(String(total.totalFormula || '').replace(/\s+/g, ''));
    requirePlan(match, 'DAILY_TOTAL_FORMULA_UNSUPPORTED', { row: total.row });
    const [start, end, criterion] = match.slice(1).map(Number);
    requirePlan(start >= 1 && start <= end && criterion === total.row, 'DAILY_TOTAL_CRITERION_UNVERIFIED', { row: total.row });
    const work = day.slice(0, -1);
    requirePlan(work.length > 0 && work.every((row, i) => normalize(row.client) && row.row === day[0].row + i)
      && total.row === day[0].row + work.length, 'DAY_NONBUSINESS_ROW_UNVERIFIED', { date: key });
    const shown = Number(/^\((-?\d+)人\)$/.exec(normalize(total.staff))[1]);
    const counted = day.filter(row => row.row >= start && row.row <= end).length - 1;
    requirePlan(shown === counted, 'DAILY_TOTAL_VALUE_UNVERIFIED', { row: total.row, shown, counted });
    return { work, total, start, end, shown };
  }

  function totalFormula(row) {
    return `="（"&(COUNTIF($A$1:$A$${row}, A${row})-1)&"人）"`;
  }

  function positionInDay(work, totalRow, client, arrival) {
    const matches = work.filter(row => normalize(row.client) === client);
    if (!matches.length) return { row: totalRow, kind: 'EXISTING_DAY_NEW_CLIENT_APPEND' };
    const timed = matches.map(row => ({ row: row.row, minute: timeMinutes(row.arrival) }));
    requirePlan(timed.every(row => row.minute !== null), 'CLIENT_ARRIVAL_TIME_UNSUPPORTED');
    requirePlan(timed.every((row, i) => i === 0 || row.minute >= timed[i - 1].minute), 'CLIENT_TIME_ORDER_CHANGED');
    const later = timed.find(row => row.minute > arrival);
    return { row: later ? later.row : timed[timed.length - 1].row + 1, kind: 'EXISTING_DAY_CLIENT_TIME_INSERT' };
  }

  function newDayPosition(month, layout, key) {
    requirePlan(layout.boundary !== Infinity, 'MONTH_DASHBOARD_BOUNDARY_UNVERIFIED');
    const earlier = layout.dated.filter(row => row.date < key);
    const previous = earlier[earlier.length - 1];
    const next = layout.dated.find(row => row.date > key);
    if (previous) readDay(layout.dated, previous.date);
    if (next) readDay(layout.dated, next.date);
    if (!previous && !next) {
      requirePlan(month.emptyTemplateRow === 2 && layout.boundary > 2 && month.rows.filter(row => row.row < layout.boundary)
        .every(row => !dateKey(row.date) && !normalize(row.client) && !normalize(row.staff)), 'MONTH_EMPTY_UNVERIFIED');
    }
    const row = next ? next.row : previous ? previous.row + 1 : month.emptyTemplateRow;
    requirePlan(row <= layout.boundary && row >= 2, 'NEW_DAY_INSERTION_UNVERIFIED');
    return {
      row, totalRow: null, insertCount: 2, totalRowAfter: row + 1, kind: 'NEW_DAY_BLOCK',
      totalDateFormulaAfter: `=A${row}`, totalFormulaAfter: totalFormula(row + 1),
      totalExpectedBefore: 0, totalExpectedAfter: 1,
    };
  }

  function choosePosition(month, date, source) {
    const key = dateKey(date);
    const client = normalize(source?.client);
    const arrival = timeMinutes(source?.arrival);
    requirePlan(key && client && arrival !== null, 'TRANSFER_POSITION_INPUT_INVALID');
    const layout = scanLayout(month, key);
    const part = readDay(layout.dated, key);
    if (!part) return newDayPosition(month, layout, key);

    const { row, kind } = positionInDay(part.work, part.total.row, client, arrival);
    const covers = part.start <= part.work[0].row && part.end >= part.total.row && part.shown === part.work.length;
    requirePlan(covers || month.allowTotalRepair === true, 'DAILY_TOTAL_RANGE_UNVERIFIED', { row: part.total.row, shown: part.shown, expected: part.work.length });
    requirePlan(row > part.start || month.allowTotalRepair === true, 'DAILY_TOTAL_INSERTION_BOUNDARY_REQUIRES_REVIEW', { row, rangeStart: part.start });
    const repair = !covers || row <= part.start;
    return {
      row, totalRow: part.total.row, insertCount: 1, totalRowAfter: part.total.row + 1, kind,
      totalFormulaBefore: part.total.totalFormula, totalFormulaAfter: repair ? totalFormula(part.total.row + 1) : null,
      totalExpectedBefore: part.shown, totalExpectedAfter: part.work.length + 1,
    };
  }

  function verifyPosition(month, date, source, insertedRow) {
    const key = dateKey(date);
    const client = normalize(source?.client);
    const arrival = timeMinutes(source?.arrival);
    requirePlan(key && client && arrival !== null && Number.isInteger(insertedRow), 'TRANSFER_POSITION_INPUT_INVALID');
    const layout = scanLayout(month, key);
    const part = readDay(layout.dated, key);
    requirePlan(part && part.start <= part.work[0].row && part.end >= part.total.row && part.shown === part.work.length,
      'POST_DAILY_TOTAL_VALUE_UNVERIFIED', { date: key });
    const added = part.work.find(row => row.row === insertedRow);
    requirePlan(added && normalize(added.client) === client && timeMinutes(added.arrival) === arrival, 'POST_PLACEMENT_CHANGED');
    const expected = positionInDay(part.work.filter(row => row.row !== insertedRow).map(row =>
      row.row > insertedRow ? { ...row, row: row.row - 1 } : row), part.total.row - 1, client, arrival);
    requirePlan(expected.row === insertedRow, 'POST_PLACEMENT_CHANGED', { expectedRow: expected.row, insertedRow });
    return { verified: true, row: insertedRow, totalRow: part.total.row, total: part.shown };
  }

  return { choosePosition, verifyPosition, dateKey, timeMinutes, workTime };
})();
