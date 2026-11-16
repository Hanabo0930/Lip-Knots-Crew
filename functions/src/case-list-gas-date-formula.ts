/** Exact pure dependency from LK_RowGuard_v1.gs, LK_SD 2.0.1.
 * Read-only source supplied from the bound project's HEAD on 2026-11-07.
 * This is not a numbered deployed revision or a live Sheet evaluation.
 */
const LK_SD = Object.freeze({ VERSION: '2.0.1', MARK: 'LK_STAFF_DATE_V2', CLOCK: 'ケイ_応募日補助', DIMS: 'LK_STAFF_DATE_DIMS_V2' });

export function staffDateLiteral(value: unknown): string {
  if (value instanceof Date) return String(value.getTime() / 86400000 + 25569 + 9 / 24);
  if (typeof value === 'number' && isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

export function expectedStaffDateFormula(row: number, name: unknown, value: unknown): string {
  const b = '$B' + row, n = staffDateLiteral(String(name == null ? '' : name));
  return '=IF(N("' + LK_SD.MARK + '"),"",IF(EXACT(TO_TEXT(' + b + '),' + n + '),' + staffDateLiteral(value) + ',IF(OR(ISFORMULA(' + b + '),LEN(TRIM(SUBSTITUTE(TO_TEXT(' + b + '),"　"," ")))=0,REGEXMATCH(TRIM(TO_TEXT(' + b + ')),"^(スタッフ名|合計|小計|総計|人数)$|^[（(]?[ 　]*[0-9０-９]+人[ 　]*[）)]?[ 　]*$")),"",\'' + LK_SD.CLOCK + '\'!$A$1)))';
}
