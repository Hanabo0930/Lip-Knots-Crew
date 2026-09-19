// 内閣府公表の国民の祝日・休日（振替休日・祝日に挟まれた休日を含む）。
// 出典: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
// 確認日: 2026-09-17。未公表年を計算式で推測しない。
export const JAPAN_HOLIDAY_CALENDAR_VERSION = "cao-2026-2027-20260917";
export const SUBMISSION_BUSINESS_DAY_SEARCH_LIMIT = 14;

const HOLIDAYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "2026": new Set([
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
    "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
    "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
    "2026-10-12", "2026-11-03", "2026-11-23",
  ]),
  "2027": new Set([
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21",
    "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
    "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23",
    "2027-10-11", "2027-11-03", "2027-11-23",
  ]),
};

export function nextSubmissionBusinessDate(dateKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const date = new Date(dateKey + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey ||
      !Object.hasOwn(HOLIDAYS, dateKey.slice(0, 4))) return null;
  for (let days = 1; days <= SUBMISSION_BUSINESS_DAY_SEARCH_LIMIT; days++) {
    date.setUTCDate(date.getUTCDate() + 1);
    const next = date.toISOString().slice(0, 10);
    const holidays = HOLIDAYS[next.slice(0, 4)];
    if (!holidays) return null;
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.has(next)) return next;
  }
  return null;
}
