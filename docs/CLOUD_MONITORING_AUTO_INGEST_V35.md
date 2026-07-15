# Cloud Monitoring自動取込 v3.5

## 動作

`collectProductionTelemetry`が5分ごとにCloud Monitoringの13指標を読み、既存の`productionSloObservations`へ記録します。記録後は1h・6h・24h・30d SLO、エラーバジェット、SEV1〜3の自動インシデント判定まで同じ処理で更新します。

同じ5分窓は`productionTelemetryRuns/{companyId}_{windowEndMs}`で一度だけ処理します。前回成功から間隔が空いた場合は最大30分までを一つの窓として回収します。

## 必須設定

1. production ProjectでCloud Monitoring APIを有効化
2. Functions実行サービスアカウントへ`roles/monitoring.viewer`を付与
3. 13個のMetric typeへ5分ごとに数値を出力
4. 管理画面でProject ID・Metric typeを保存
5. 「13指標を接続テスト」に合格後、自動取込をON

件数系は観測窓内の合計、p95と最古queueは観測窓内の最大値として集計します。p95はMonitoring側で算出済みのミリ秒数を出力してください。

標準名は`config-samples/production-telemetry.example.json`にあります。実際のMetric typeが異なる場合だけ管理画面で変更します。認証失敗・Functions失敗・スプシ失敗・通知失敗は、それぞれの試行数を超えてはいけません。

## 安全設計

- Project IDと全13 Metric typeをサーバーで再検証
- 接続テスト未合格、production未有効、署名承認Releaseなしでは取込禁止
- 欠落・NaN・負数・失敗数超過・ページ上限超過は窓全体を拒否
- 欠落値を0として扱わない
- 取込失敗時は`collection_error`を保存し、SLO監視鮮度の低下でSEV判定
- Firebaseクライアントから設定・実行履歴へ直接書込不可
- 認証鍵JSONは保存せず、FunctionsのApplication Default Credentialsを使用

## 証跡

- 設定: `productionTelemetryConfigs/{companyId}`
- 実行: `productionTelemetryRuns/{companyId}_{windowEndMs}`
- SLO原観測: `productionSloObservations/{observationId}`
- 時間集計: `productionSloHourBuckets/{companyId}_{hour}`
- 監査: `auditLogs`の`production_telemetry.*`

## デモ

ZIP解凍後、Windowsでは`アプリを見る_WINDOWS.cmd`を実行します。ローカルデモはFirebase未設定で起動し、外部送信・本番更新を行いません。
