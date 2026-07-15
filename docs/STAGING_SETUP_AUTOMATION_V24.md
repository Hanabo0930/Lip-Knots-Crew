# staging自動構築 v2.4

## 1. 設定を1つ作る

```bash
mkdir -p config
cp config-samples/staging-setup.example.json config/staging-setup.json
chmod 600 config/staging-setup.json
```

`config/staging-setup.json`内の`YOUR_...`を実際のstaging・production識別値へ置換します。このファイルはGit管理対象外です。

## 2. 値を表示せずpreview

```bash
npm run setup:staging:preview
```

生成予定の6ファイル名だけを表示します。秘密値やProject IDは表示しません。

## 3. staging設定を生成

```bash
npm run setup:staging
```

以下を権限600で生成し、そのままpreflightを実行します。

- `.firebaserc`
- `config/environments/staging.json`
- `config/staging-smoke.json`
- `apps/staff/.env.staging`
- `apps/admin/.env.staging`
- `functions/.env.staging`

既存設定がある場合は停止します。意図して置換する場合だけ`npm run setup:staging:replace`を使用します。置換前ファイルは`.staging-setup-backups/`へ退避され、Git管理されません。

## 4. buildとデプロイ事前診断

```bash
npm run release:staging
```

preflight合格後にstaff・admin・Functionsをstaging modeでbuildし、次を診断します。

- Node 22 runtime
- Functions predeploy
- staff/admin Hosting target・SPA rewrite
- Firestore・Storage rulesとindexes
- build成果物の存在・鮮度
- 古いentry chunkの残留
- Firebase CLIの実行可否

診断合格後、Firebase CLIで対象Projectがstagingであることを確認してから、functions・firestore・storage・hostingをデプロイします。本コマンド自体はデプロイしません。

## 安全仕様

- サンプル値・Project重複・Hosting重複・HTTP URL・改行注入を拒否
- staff/admin App IDを分離
- Functions regionを`asia-northeast1`へ固定
- staging決済・メール・Pushをtest/captureへ固定
- Emulatorを必ず無効化
- 設定値を標準出力へ表示しない
