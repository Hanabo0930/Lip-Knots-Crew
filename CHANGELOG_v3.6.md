# CHANGELOG v3.6

## 実測指標の生成

- 認証、スプシ書込、通知、データ差異、重大停止を企業別の5分bucketで計測。
- Cloud Runの要求数・5xx・p95応答時間、queue最古滞留を自動取得。
- 完了済5分窓から13指標をCloud Monitoringへ送信。すべてに`company_id`ラベルを強制。
- 指標生成を毎5分の1分offset、SLO取込を3分offsetで自動実行。
- 生成runの重複防止、成功・失敗証拠、監査ログを追加。

## 本番診断

- 本番環境、Project一致、署名承認、全体停止、監視設定、13指標、企業分離、接続テスト、生成・取込状態と鮮度の12項目を自動判定。
- 管理画面に実測生成、最終生成・取込、12/12 READY診断を追加。
- ビルド、Node 22、Firebaseデプロイ範囲、Monitoring IAM、13指標、Rules、Hosting、秘密値混入を検査する非破壊CLIを追加。

## 安全性・検証

- Cloud Monitoring取込filterに`metric.labels.company_id`を必須化。
- Metric bucketとexport runをサーバー専用のFirestoreルールで保護。
- 実測生成コア21件、本番ランタイム診断18件、デプロイ前診断15件を追加。
- ローカルデモは外部送信なしで新しい管理画面を確認可能。
