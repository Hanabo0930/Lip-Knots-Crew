'use strict';
// Native-shaped synthetic evidence for the actual compact constructor. This
// helper makes no network calls and never treats unread fields as empty.
const assert = require('node:assert/strict');
const Compact = require('../../functions/src/case-list-monthly-compact.cjs');

const MONTHS = [
  { sheetId: 1773116117, title: '2026.11', columnCount: 55 },
  { sheetId: 434431224, title: '2026.12', columnCount: 56 },
];
const clone = value => JSON.parse(JSON.stringify(value));
const literal = value => {
  const kind = typeof value === 'number' ? 'numberValue' : typeof value === 'boolean' ? 'boolValue' : 'stringValue';
  return { userEnteredValue: { [kind]: value }, effectiveValue: { [kind]: value } };
};
const headerCells = headers => headers.map(value => typeof value === 'string' ? literal(value) : value);
const columnNumber = value => [...value].reduce((n, character) => n * 26 + character.charCodeAt(0) - 64, 0) - 1;

/**
 * state is the worker harness' current mutable synthetic grid, not a cached
 * snapshot: {book, caseId, sourceHeader, sourceCells, ledger, month}.
 * Optional sourceRows/sourceRowCount and months permit global identity/race
 * fixtures while retaining complete physical index coverage.
 */
function createWorkerCompactEvidence(state) {
  assert.equal(typeof state.book, 'string');
  assert.equal(typeof state.caseId, 'string');
  assert.equal(state.sourceHeader.length, 65);
  assert.equal(state.sourceCells.length, 65);
  assert.ok(Array.isArray(state.ledger) && state.ledger.length >= 3);
  const sourceRows = state.sourceRows || [{ row: 2, cells: state.sourceCells }];
  const sourceRowCount = state.sourceRowCount || Math.max(2, ...sourceRows.map(row => row.row));
  const source = {
    sheetId: 2026101601, title: '案件リスト', rowCount: sourceRowCount, columnCount: 65,
    headerRow: 0, headers: headerCells(state.sourceHeader),
    rows: new Map(sourceRows.map(row => [row.row - 1, row.cells])),
  };
  const ledger = {
    sheetId: 2026102605, title: '案件_実績台帳', rowCount: state.ledger.length, columnCount: 25,
    headerRow: 2, headers: headerCells(state.ledger[2]),
    rows: new Map(state.ledger.map((cells, row) => [row, cells])),
  };
  const inputMonths = state.months || [state.month];
  const businessHeaders = state.sourceHeader.slice(1, 55).map(cell => typeof cell === 'string' ? cell : cell.userEnteredValue.stringValue);
  const months = MONTHS.map(binding => {
    const found = inputMonths.filter(month => month && month.title === binding.title);
    assert.ok(found.length <= 1, 'Duplicate synthetic month input');
    const month = found[0];
    if (month) assert.equal(month.sheetId, binding.sheetId, 'Journey must use the compact schema month ID');
    return {
      ...binding, rowCount: month ? month.rowCount : 2, headerRow: 0,
      headers: headerCells(month ? month.headers : [...businessHeaders, ...(binding.columnCount === 56 ? [''] : []), '連絡_固定案件ID']),
      rows: new Map(month ? month.rows.map(row => [row.row - 1, row.cells]) : []),
    };
  });
  // These are explicit synthetic dependency values with their own complete
  // read receipts, rather than an arbitrary precomputed dependency hash.
  const dependencies = Compact.DEPENDENCIES.map((title, index) => ({
    sheetId: 800 + index, title, rowCount: 2, columnCount: 2, headerRow: 0,
    headers: [literal('SYNTHETIC_DEPENDENCY'), literal(title)],
    rows: new Map([[1, [literal(index), literal('FIXTURE_VALUE')]]]),
  }));
  const tables = [source, ledger, ...months, ...dependencies];
  const metadata = {
    spreadsheetId: state.book, properties: { timeZone: 'Asia/Tokyo' },
    sheets: tables.map(table => ({ properties: {
      sheetId: table.sheetId, title: table.title,
      gridProperties: { rowCount: table.rowCount, columnCount: table.columnCount },
    } })),
  };
  const cellAt = (table, row, column) => row === table.headerRow ? table.headers[column] || {} : table.rows.get(row)?.[column] || {};
  function recorded(ranges, fields) {
    const request = {
      spreadsheetId: state.book, ranges, includeGridData: true,
      fields: 'spreadsheetId,properties.timeZone,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData.values(' + fields.join(',') + ')))',
    };
    const response = clone(metadata);
    for (const sheet of response.sheets) sheet.data = [];
    for (const range of ranges) {
      const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
      assert.ok(match, 'Bounded A1 range required');
      const table = tables.find(value => value.title === match[1].replace(/''/g, "'"));
      assert.ok(table, 'Read must name one synthetic table');
      const startRow = Number(match[3]) - 1, endRow = Number(match[5]);
      const startColumn = columnNumber(match[2]), endColumn = columnNumber(match[4]) + 1;
      const rowData = [];
      for (let row = startRow; row < endRow; row++) {
        const values = [];
        for (let column = startColumn; column < endColumn; column++) {
          const value = cellAt(table, row, column);
          values.push(clone(Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]))));
        }
        rowData.push({ values });
      }
      response.sheets.find(sheet => sheet.properties.sheetId === table.sheetId).data.push({ startRow, startColumn, rowData });
    }
    response.sheets = response.sheets.filter(sheet => sheet.data.length);
    return { request, response };
  }
  const indexReads = [recorded(Compact.createIndexRanges(metadata), Compact.VALUE_FIELDS)];
  const plan = Compact.inspectCompactIndex({ metadata, indexReads, caseId: state.caseId });
  return {
    metadata, indexReads,
    fullReads: [recorded(plan.fullRanges, Compact.FULL_FIELDS)],
    valueReads: plan.ledgerRange ? [recorded([plan.ledgerRange], Compact.VALUE_FIELDS)] : [],
    caseId: state.caseId, includeDependencies: true,
    dependencyEvidence: Compact.createDependencyPlans(metadata).map(dependency => Compact.createDependencyEvidence({
      metadata, title: dependency.title, reads: [recorded([dependency.range], Compact.VALUE_FIELDS)],
    })),
  };
}

function buildWorkerCompactSnapshot(state, resolveStaff) {
  return Compact.createCompactSnapshot({ ...createWorkerCompactEvidence(state), resolveStaff });
}

module.exports = { buildWorkerCompactSnapshot, createWorkerCompactEvidence, MONTHS };
