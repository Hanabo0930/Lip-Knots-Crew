// Shared error identity stays in the entry; lock machinery loads with the submission store.
export class SubmissionContextBusyError extends Error {
  constructor() { super("別の画面でこの提出を処理しています。選択ファイルは保持しています。再送せず提出履歴を確認してください。"); this.name = "SubmissionContextBusyError"; }
}
