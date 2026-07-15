import { hashText } from "./case-id";

export function normalizeStaffName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .trim();
}

export function createStaffId(companyId: string, displayName: string): string {
  const normalizedName = normalizeStaffName(displayName);
  return `staff_${hashText(`${companyId}|${normalizedName}`, 24)}`;
}

export function normalizePhone(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\d+]/g, "")
    .trim();
}

export function splitEmails(value: string): string[] {
  const candidates = value
    .normalize("NFKC")
    .split(/[\s　,，、;；\n\r]+/u)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(candidates)];
}

export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
