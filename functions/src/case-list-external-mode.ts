/** Server-only rollout control. No Firestore schema or client grant.
 * Unset/invalid is read-only. Only the reviewed enabled revision may create a
 * new protected external selection. Paused permits exact existing receipt
 * reconciliation; the compatibility build pins read-only regardless of env.
 * This file does not change a deployed environment or stop the GAS producer.
 */
export const EXTERNAL_COMPATIBILITY_ONLY = false;
export function externalTransferMode(): "enabled" | "paused" | "read-only" {
  if (EXTERNAL_COMPATIBILITY_ONLY) return "read-only";
  const mode = process.env.LKC_CASE_LIST_EXTERNAL_MODE;
  return mode === "enabled" || mode === "paused" ? mode : "read-only";
}
export function assertExternalIntakeEnabled(): void {
  if (externalTransferMode() !== "enabled") throw Error("EXTERNAL_TRANSFER_INTAKE_PAUSED");
}
export function assertExternalAcceptanceEnabled(): void {
  if (externalTransferMode() === "read-only") throw Error("EXTERNAL_TRANSFER_COMPATIBILITY_HOLD");
}
