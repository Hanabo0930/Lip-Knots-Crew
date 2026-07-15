# 承認付き本番デプロイ指揮 v3.8

## 実行順

1. `本番セットアップ_WINDOWS.cmd`で本番8ファイルを生成する。
2. `npm run deploy:production:prepare`で計画指紋と承認下書きを生成する。
3. `config/production-deploy-approval.json`へ承認者、変更票、直前checkpoint、Hosting復旧元、5つの確認結果を入力する。
4. `npm run deploy:production:validate`でProject・Release・scope・指紋・30分TTL・承認者allowlistを検査する。
5. `npm run deploy:production -- --confirm <PLAN_FINGERPRINT>`で実行する。

Windowsでは`本番デプロイ_WINDOWS.cmd`が同じ手順を案内する。Node 22とFirebase CLIが必須で、Firebase CLIのProject一覧に対象Projectが存在しない場合は最初のdeploy前に停止する。

## 3段階

1. `firebase deploy --only firestore,storage`
2. `firebase deploy --only functions`
3. `firebase deploy --only hosting:staff,hosting:admin`

各コマンドは対象Project、非対話、JSON出力を固定する。シェル文字列を組み立てず、引数配列で実行する。失敗後の続行は禁止する。

Firebase CLIは`--only`による部分デプロイ、`functions:list`、`hosting:sites:list`、Hosting cloneを提供する。HostingはConsoleからrollbackできる一方、Rules releaseはFirebase CLIからrollbackできないため、既知正常版のRules再デプロイを復旧手順に固定する。

公式仕様: https://firebase.google.com/docs/cli

## 承認条件

- Release `v3.8.0`、対象Project、5 deploy scope、計画指紋が完全一致。
- `EXECUTIVE_APPROVER_EMAILS`に含まれる承認者メール。
- 承認から30分以内。未来時刻、期限切れ、30分超の有効期間を拒否。
- backup、直前source checkpoint、Rules rollback制約、緊急停止責任者、Hosting rollback責任者の5確認がすべてtrue。
- 64文字の計画指紋を実行時に再入力。

## 証跡と失敗時

- 成功・失敗結果: `release-evidence/production/deployment-result.json`
- 失敗時復旧計画: `release-evidence/production/rollback-plan.json`
- 計画: `release-evidence/production/deployment-plan.json`

証跡はGit・配布ZIP対象外。Access Token、Authorization、private key、client secretは自動マスクする。失敗時は全体停止と変更凍結を先に行い、Hostingは直前版、Functionsは直前source checkpoint、Rulesは既知正常版を再配備する。
