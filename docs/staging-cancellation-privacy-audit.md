# STAGING取消状態の読取監査

既存の `Staging Functions Deploy` を main から起動し、次の専用モードを選ぶ。

| 入力 | 値 |
| --- | --- |
| operation | cancellation-privacy-audit |
| source_ref | main |
| functions | none |
| transfer_mode | preserve |
| confirmation | AUDIT_LKC_STAGING_CANCELLATION_PRIVACY |

このモードは既存の observer、既存保護環境、mainの正式CIを使用する。deploy/Gmail smokeのjobは対象外。認証の前と保護レビュー後に現在mainを照合し、再実行・別branch・別workflow・Functions指定・停止状態の変更を拒否する。

呼び出す監査は既存の `scripts/audit-staging-cancellation-privacy.mjs` 1本だけで、処理を複製しない。固定STAGINGの全jobsからstatus/cancelledの2項目を読取専用transactionで取得し、rollbackする。保存するのは集計だけ。書込み・修正・取消・実送信・配備を実行する機能はない。権限拒否、不完全、矛盾は停止とし、PASSでも配備許可を意味しない。

独立した監査workflowの実行40793656805は、既存federation attribute conditionで認証が拒否され、データを読む前に停止した。その実行を再試行したりworkflow_refを偽装したりせず、監査の実行入口を通常のCI・merge・保護レビューで既存の信頼済みworkflowへ統合する。独立入口は削除し、過去の実行履歴は保持する。WIF条件、IAM role/binding、保護設定、資格情報は変更しない。

2026-10-29、本人の「止まってる部分を解決して進めてくれ」を受けた修正。承認済みの狭い取消非公開化の読取前提を回復する範囲に限定し、原本業務write、本番、GAS、実送信、停止解除の許可を追加しない。配備済みfederationの現在値は未取得であり、repo内bootstrapだけから現在条件や必要roleを断定しない。この入口でも認証/読取が拒否される場合は、権限を拡張せず実結果を記録する。
