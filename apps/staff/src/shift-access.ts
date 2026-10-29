export function isShiftAccessDenied(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^(?:(?:firestore|functions)\/)?permission-denied$/.test(code);
}
