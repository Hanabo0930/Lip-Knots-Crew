import { Timestamp } from "firebase-admin/firestore";

export type TokyoParts = {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const TOKYO_OFFSET = "+09:00";

export function tokyoParts(date: Date): TokyoParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    dateKey,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayMap[values.weekday ?? ""] ?? 0,
  };
}

export function tokyoTimestamp(
  dateKey: string,
  hour: number,
  minute: number
): Timestamp {
  return Timestamp.fromDate(
    new Date(`${dateKey}T${pad(hour)}:${pad(minute)}:00${TOKYO_OFFSET}`)
  );
}

export function addTokyoDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00${TOKYO_OFFSET}`);
  date.setUTCDate(date.getUTCDate() + days);
  return tokyoParts(date).dateKey;
}

export function compareDateKeys(left: string, right: string): number {
  return left.localeCompare(right);
}

export function isQuietTime(date: Date): boolean {
  const { hour } = tokyoParts(date);
  return hour >= 22 || hour < 7;
}

export function applyQuietHours(preferred: Timestamp): {
  deliverAt: Timestamp;
  quietDeferred: boolean;
} {
  const date = preferred.toDate();
  const parts = tokyoParts(date);
  if (parts.hour >= 7 && parts.hour < 22) {
    return { deliverAt: preferred, quietDeferred: false };
  }

  const deliveryDate = parts.hour >= 22
    ? addTokyoDays(parts.dateKey, 1)
    : parts.dateKey;
  return {
    deliverAt: tokyoTimestamp(deliveryDate, 7, 0),
    quietDeferred: true,
  };
}

export function isWithinMinuteWindow(
  now: Date,
  targetHour: number,
  targetMinute: number,
  windowMinutes = 5
): boolean {
  const parts = tokyoParts(now);
  const current = parts.hour * 60 + parts.minute;
  const target = targetHour * 60 + targetMinute;
  return current >= target && current < target + windowMinutes;
}

export function submissionDeadline(dateKey: string): Timestamp {
  const source = new Date(`${dateKey}T00:00:00${TOKYO_OFFSET}`);
  const weekday = tokyoParts(source).weekday;
  const daysUntilDeadline = weekday === 6 ? 2 : weekday === 0 ? 1 : 1;
  return tokyoTimestamp(addTokyoDays(dateKey, daysUntilDeadline), 11, 0);
}

export function timestampMinusMinutes(
  timestamp: Timestamp,
  minutes: number
): Timestamp {
  return Timestamp.fromMillis(timestamp.toMillis() - minutes * 60_000);
}

export function minuteBucket(date: Date, sizeMinutes = 5): string {
  const parts = tokyoParts(date);
  const minute = Math.floor(parts.minute / sizeMinutes) * sizeMinutes;
  return `${parts.dateKey}T${pad(parts.hour)}:${pad(minute)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
