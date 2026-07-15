# 本番Firebaseセットアップウィザード v3.7

## Windows

1. `本番セットアップ_WINDOWS.cmd`をダブルクリックします。
2. 初回は`config/production-setup.json`が作成され、メモ帳で開きます。
3. `YOUR_`で始まる項目を実値へ変更して保存します。秘密鍵・Service Account JSON・Access Tokenは入力しません。
4. もう一度同じcmdを実行し、検査結果を確認して`Y`を選びます。
5. 8ファイル生成後、デプロイ前診断が実行されます。Firebaseデプロイは行いません。

## CLI

```bash
cp config-samples/production-setup.example.json config/production-setup.json
chmod 600 config/production-setup.json
npm run setup:production:preview
npm run setup:production
```

既存設定がある場合、通常コマンドは上書きを拒否します。明示的に置換する場合だけ`npm run setup:production:replace`を使います。置換前の全ファイルは`.production-setup-backups/`に退避されます。

## 生成対象

1. `.firebaserc`
2. `config/environments/production.json`
3. `config/production-deploy.json`
4. `config/production-telemetry.json`
5. `config/production-bootstrap.json`
6. `apps/staff/.env.production`
7. `apps/admin/.env.production`
8. `functions/.env.production`

## 必須安全条件

- development・staging・productionのProject IDがすべて異なること。
- productionのstaff/admin Hosting siteとFirebase App IDが異なること。
- Functionsは`asia-northeast1`、実行ランタイムはNode.js 22であること。
- 13 Metric typeは`custom.googleapis.com/lip_knots`、企業ラベルは`company_id`であること。
- 入力JSONに秘密鍵、Service Account、client secret、access/refresh tokenを保存しないこと。

## 生成後

`npm run diagnose:production`がPASSした後にも、管理画面の12項目がREADYになるまで本番有効化は行いません。実デプロイは認証済み操作者が、対象Projectとdeploy scopeを再確認して別途実行します。
