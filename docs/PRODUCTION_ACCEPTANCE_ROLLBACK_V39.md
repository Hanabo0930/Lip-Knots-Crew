# 本番受入・ロールバック指揮 v3.9

## 1. 原則

- previewは外部通信・保存・デプロイ・ロールバックを行わない。
- 実受入は成功済みデプロイ証跡から30分以内に開始する。
- 9項目を5分間隔で3回合格して初めて`accepted`とする。
- 1件でも失敗したら通常受入を打ち切り、緊急停止を維持する。
- ロールバック後も自動解除せず、旧版専用の復旧受入を3回行う。

## 2. デプロイ前に既知正常bundleを作る

既知正常版の解凍済みソースで`npm ci --ignore-scripts`と`npm run build`を合格させます。そのソースを指定してpreview後に保存します。

```bash
npm run rollback:bundle:preview -- --source ../Lip_Knots_Crew_v3.8 --release v3.8.0 --project lip-knots-production
npm run rollback:bundle -- --source ../Lip_Knots_Crew_v3.8 --release v3.8.0 --project lip-knots-production
```

保存先は`rollback-sources/v3.8.0`です。Git・配布ZIPには含めず、改ざん防止領域へ保管します。

## 3. 通常受入

`本番セットアップ_WINDOWS.cmd`で10ファイルを生成し、承認付きデプロイ成功後に次を実行します。

```bash
npm run acceptance:production:preview
npm run acceptance:production
```

`OBSERVING 1/3`、`2/3`では表示された`next`以降に再実行します。`ACCEPTED 3/3`で受入完了です。

検査対象は次の9項目です。

1. 対象Firebase Projectへのアクセス
2. 必須Functions 6本
3. Staff/Admin Hosting site
4. Staff画面と5セキュリティヘッダー
5. Staff PWA manifest
6. Admin画面と5セキュリティヘッダー
7. Admin PWA manifest
8. Login Gatewayの安全な拒否応答
9. Drive Previewの安全な拒否応答

## 4. 受入失敗時

失敗すると`rollback-trigger.json`が保存されます。`config/production-rollback-request.json`へ既知正常Release、bundle path、Staff/Admin Hostingの復旧元versionを入力します。

```bash
npm run rollback:production:preview
npm run rollback:production:prepare
npm run rollback:production:validate
npm run rollback:production -- --confirm <ROLLBACK_FINGERPRINT> --typed ROLLBACK_PRODUCTION
```

承認者はデプロイ承認者と別人、allowlist登録済み、承認期限15分以内である必要があります。6項目の確認をすべて`true`にします。

実行順は次です。失敗した時点で後続stageは実行しません。

1. 既知正常版のFirestore Rules・indexes・Storage Rulesを再デプロイ
2. 既知正常版Functionsを再デプロイ
3. Staff Hostingを指定versionからliveへclone
4. Admin Hostingを指定versionからliveへclone
5. Functions・Hosting inventoryとStaff/Admin HTTPSを確認

Firebase CLIではRules releaseを直接rollbackできないため、既知正常Rulesの再デプロイを固定手順にしています。Hostingは`hosting:clone`で指定versionをliveへ複製します。

## 5. 復旧受入

ロールバック成功後、緊急停止を維持したまま次を5分間隔で3回実行します。

```bash
npm run acceptance:production:recovery
```

通常受入とは別の`rollback-acceptance-ledger.json`へ、実際の既知正常Releaseを記録します。1回でも失敗したら`FAILED LOCKED`です。3/3合格後も自動解除は行わず、責任者の承認と証跡を残して解除します。

## 6. 証跡

- `release-evidence/production/acceptance-run-*.json`
- `release-evidence/production/acceptance-ledger.json`
- `release-evidence/production/rollback-trigger.json`
- `release-evidence/production/rollback-execution-plan.json`
- `release-evidence/production/rollback-result.json`
- `release-evidence/production/rollback-acceptance-ledger.json`

これら、実承認JSON、実設定、既知正常bundleは配布ZIP対象外です。
