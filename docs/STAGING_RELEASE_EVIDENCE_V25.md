# staging証跡・rollback v2.5

## 1. checkpoint preview

```bash
npm run checkpoint:staging:preview
```

実Project IDや秘密値を表示せず、checkpoint作成条件だけを確認します。

## 2. リリース直前checkpoint

```bash
npm run checkpoint:staging
```

staging preflight・build・デプロイ診断に合格後、`release-evidence/staging/<release-id>`を作成します。

checkpointにはソース、staff/admin build、Functions build、Rules、package lock、運用資料を含め、各ファイルをSHA-256で固定します。次は含みません。

- `.firebaserc`
- actual `.env`・`.env.staging`
- `config/staging-setup.json`
- `config/staging-smoke.json`
- `config/environments/`
- `.staging-setup-backups/`
- node_modules・テスト生成物

checkpoint一式は監査証跡として`05_監査・移行`へ保管します。秘密設定は承認済みの安全な保管先で別管理します。

## 3. デプロイ結果を記録

```bash
npm run evidence:staging:record -- \
  --checkpoint release-evidence/staging/<release-id> \
  --status succeeded \
  --operator <担当者> \
  --release-ref <Hosting等のrelease参照> \
  --release-ref <Functions等のrelease参照> \
  --notes "staging verified"
```

statusは`succeeded`・`failed`・`rolled_back`のいずれかです。記録内容は`deployment-result.json`とSHA-256へ保存され、値は標準出力へ表示しません。

成功結果を記録した後は`STAGING_SMOKE_GO_NO_GO_V26.md`に従い、実URLスモークとGo/No-Go証跡を同じcheckpointへ保存します。

## 4. rollback checkpoint検証

```bash
npm run rollback:staging:verify -- \
  --checkpoint release-evidence/staging/<release-id>
```

manifest、全ファイル、デプロイ結果、smoke・Go/No-Go証跡のSHA-256と、追加・欠落・危険パスを検査します。

## 5. 空の隔離フォルダへ復元

```bash
npm run rollback:staging:prepare -- \
  --checkpoint release-evidence/staging/<release-id> \
  --restore-to rollback-restores/<release-id>
```

復元先が空でない場合は停止します。現行本体は変更しません。復元後は承認済みのstaging秘密設定を追加し、`npm ci`、`npm run release:staging`、人による対象Project確認を行ってからデプロイします。

## 安全仕様

- rollbackとデプロイは自動実行しない
- 現行本体を上書きしない
- 秘密値をcheckpointへ含めない
- 改ざんcheckpointを復元しない
- 実デプロイ前に人の確認を必須とする
