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

## 実読取と状態診断

実行40802270788（main 60ecd7f、PR241統合後）では、既存observer認証とCLI設定が成功し、読取監査が `UNKNOWN_JOB_STATUS` / `INCOMPLETE` で停止した。業務書込・原本requestは0。これにより認証回復は確認できたが、取消矛盾ゼロや配備可能とは扱わない。

監査の既知状態へ、既存 `functions/src/automation-bridge-core.ts` が宣言する `archived` を含める。これを取消扱いへ変換せず、archivedかつcancelled=trueも矛盾としてHOLDにする。実行40802270788の原因がarchivedだったとは推測しない。

未宣言状態・状態欠落・型不正は引き続きINCOMPLETEとして拒否する。完全な読取スナップショットを走査できた場合だけ、既知の固定状態別件数とunknown/missing/invalid件数を補足する。未知の実値、案件ID、氏名、理由、トークンは出さない。診断件数をzeroConflictsや配備許可として利用しない。途中の応答不備・上限超過・rollback失敗では診断集計も出さない。

実行40806372992（main8883d26、正式40804904519全3成功後）は認証/読取成功、全4件を走査してassigned3件・未知1件、欠落0・型不正0を記録しINCOMPLETEで停止した。既存権限のFirebase consoleを読取で確認すると、未知1件は既存 `scripts/submission-acceptance-kit.mjs` の合成提出受入キットと会社・日付2000-01-01・合成店舗/取引先が一致し、statusはcompletedだった。データ変更や削除は行わない。

その既存状態completedも全件監査の対象へ含める。completedをassignedへ読み替えず、cancelled=trueならHOLD。合成案件を除外するqueryや会社別例外は追加しない。未知/欠落/型不正の拒否・rollback・deploymentReady=falseを維持する。この補足のソース検証と、修正後の実監査成功は別工程とする。
