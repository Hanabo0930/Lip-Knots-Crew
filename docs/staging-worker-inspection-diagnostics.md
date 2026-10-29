# Worker構成点検での403診断

既存 `staging-worker-migration.yml` の `operation=inspect` は同じobserver・同じ29件の構成読取を使う。Scheduler一覧の403を受けた場合だけ、HTTP応答の `google.rpc.ErrorInfo` から固定値の診断を付ける。再試行、別identityへの切替、IAM・API有効化・認証スコープ変更は行わない。

`failedRead.errorInfo` に許す分類は `IAM_PERMISSION_DENIED`、`SERVICE_DISABLED`、`ACCESS_TOKEN_SCOPE_INSUFFICIENT`。domainも固定値だけを許す。permissionを出す場合は応答に明示された `cloudscheduler.jobs.list`、serviceを出す場合は `cloudscheduler.googleapis.com` との完全一致が必要。欠けた項目を推定補完しない。IAM分類も特定ロールが不足している証拠とは扱わない。

応答本文は最大16KiB、ErrorInfoは1件だけを受け入れる。自由文、resource、consumer、activationUrl、認証情報、ポリシー、他のmetadataは出力・保存しない。未知・不正・途中切断・複数分類の応答は従来の `API_HTTP_403` だけを残す。点検結果は引き続き `INSPECTION_INCOMPLETE`、`cloudMutation=false`、`configurationComplete=false`、`executionDrainProven=false` で停止する。

ローカル検証：`PYTHONDONTWRITEBYTECODE=1 python3 scripts/automation/test-staging-worker-migration.py`。実HTTP transportを模した403分類、秘密の除去、未対応応答、書込エラーへの非適用、読取summaryへの接続と副作用停止を検証する。ローカル成功は実環境の拒否理由確認や配備完了とは別。

応答仕様の参照：[Google API ErrorReason](https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto)、[IAM permission errors](https://docs.cloud.google.com/iam/docs/permission-error-messages)。
