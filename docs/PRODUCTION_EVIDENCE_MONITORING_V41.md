# 本番証跡差分監視・異常通知 v4.1

## 運用

1. デプロイ、受入、rollback、復旧受入の各実行後に`本番証跡同期_WINDOWS.cmd`を実行する。
2. `release-evidence/production/admin-sync-package.json`を管理画面の「証跡JSONを同期」へ読み込む。
3. 状態、期限、次行動、差分履歴を確認する。WATCH・CRITICALは対応内容を5文字以上で固定する。

## 自動判定

- `deployed`は7分以内に受入観測を開始。超過後8分までWATCH、それ以降はCRITICAL。
- 受入・復旧観測は最後のrunから7分を期限とし、停滞を検知。
- `rollback_required`、rollback失敗、復旧失敗はCRITICAL。rollback成功後は復旧受入開始までWATCH。
- `accepted`と`recovered`はCOMPLETE。

## 通知・権限

- 状態変化は即時通知。CRITICAL継続中は30分間隔で再通知。回復時も通知。
- 定期監視は5分間隔、1回100企業まで処理。
- 取得・同期・確認はproduction、管理者、同一企業に限定。生CLI出力と秘密値は保存しない。
- 管理画面は30秒自動更新。手動でOFFにできる。

## 必須Functions

`loginGateway`, `driveFilePreview`, `getProductionControlStatus`, `getProductionDeploymentReadiness`, `getProductionSloDashboard`, `getProductionTelemetryStatus`, `getProductionReleaseEvidenceStatus`, `importProductionReleaseEvidence`, `acknowledgeProductionEvidenceAlert`, `monitorProductionReleaseEvidence`
