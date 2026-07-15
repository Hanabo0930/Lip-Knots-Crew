# staging安全ゲート v2.3

v2.4以降は`STAGING_SETUP_AUTOMATION_V24.md`の自動生成を推奨します。以下は手動設定時の手順です。

## 1. 設定ファイルを作る

```bash
cp .firebaserc.example .firebaserc
mkdir -p config/environments
cp config-samples/environments/staging.json config/environments/staging.json
cp apps/staff/.env.staging.example apps/staff/.env.staging
cp apps/admin/.env.staging.example apps/admin/.env.staging
cp functions/.env.staging.example functions/.env.staging
```

5ファイル内の`YOUR_...`と`example.com`を実際のstaging値へ置換します。実値ファイルはGit管理しません。

## 2. 安全検査

```bash
npm run preflight:staging
```

検査は環境alias、Project ID、Hosting target、URL、Spreadsheet、Backup、Stripe、Email、Push、Emulator、Web設定、Functions設定を照合します。不一致が1件でもあれば終了コード1で停止します。

## 3. stagingビルド

```bash
npm run build:staging
firebase use staging
```

`build:staging`は安全検査合格後だけスタッフPWA・管理画面・Functionsをビルドします。デプロイ前に`firebase use`の表示がstaging Project IDであることを確認してください。

## 実行時の二重防御

- Web本体とService Workerは`VITE_EXPECTED_FIREBASE_PROJECT_ID`との不一致で起動停止
- stagingでEmulatorが有効なら起動停止
- Functionsは`EXPECTED_FIREBASE_PROJECT_ID`と実行Project IDの不一致で起動停止
