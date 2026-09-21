/** 書戻しと定期再試行を、明示的に有効化されるまで停止する。 */
export function sheetWriteExecutionPaused(): boolean {
  // 未設定・未知値でも既存依頼を消費しない。環境名による暗黙の有効化は行わない。
  return process.env.LKC_SHEET_WRITE_MODE !== "active";
}
