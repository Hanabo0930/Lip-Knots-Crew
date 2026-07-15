# 実測指標生成・本番デプロイ診 v3.6

## 自動フロー

1. 本番処理が企業別の5分bucketに認証・書込・通知・差異・重大停止を加算します。
2. 毎5分の1分offsetで、完了済5分窓のbucket、Cloud Run、queueから13指標を組み立てます。
3. 13指標を`company_id`付きcustom metricとしてCloud Monitoringへ送信します。
4. 毎5分の3分offsetで同じ`company_id`の指標だけを取り込み、SLO・エラーバジェット・SEV判定を更新します。

## 本番前設定

1. `config-samples/production-deploy.example.json`を`config/production-deploy.json`に複製し、Project IDだけを実値へ変更します。
2. Functionsサービスアカウンに`roles/monitoring.viewer`と`roles/monitoring.metricWriter`を最小範囲で付与します。
3. `APP_ENVIRONMENT=production`と`PRODUCTION_FIREBASE_PROJECT_ID`を実行環境に設定します。
4. 管理画面でProject IDと13 Metric typeを保存し、「企業分離を接続テスト」を合格させます。
5. 署名承認Releaseを有効化し、全体停止がOFFであることを確認します。

## 診断

Node.js 22と本番ビルド完了後に次を実行します。このコマンドは診断のみでデプロイしません。

```bash
npm run diagnose:production
```

管理画面の「本番運用・デプロイ自動診断」は、実行中の状態を12項目で判定します。`12/12 READY`と、最終生成・取込がともに10分以内であることを確認します。

## 安全上の注意

- `config/production-deploy.json`に秘密値、private key、access token、サービスアカウンJSONを書かないでください。
- 認証鍵はSecret ManagerまたはGoogle管理の認証情報だけを使用します。
- production環境と署名承認Releaseが有効でない場合、手動指標生成は拒否されます。
- 取込は必ず`metric.labels.company_id`で対象企業を限定します。
