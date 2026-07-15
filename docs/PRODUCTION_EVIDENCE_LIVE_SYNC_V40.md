# 本番証跡ライブ同期 v4.0

## 1. 同期前提

- Node.js 22、Firebase CLI認証、実production設定が必要です。
- 承認付きデプロイ成功後に、本番受入を5分間隔で3回行います。
- 受入失敗時だけ別承認ロールバックを行い、復旧受入を3回行います。
- 実証跡と同期JSONは`release-evidence/production`に保存され、配布ZIPには含まれません。

## 2. 同期JSON生成

Windowsは`本番証跡同期_WINDOWS.cmd`を実行します。CLIでは次を実行します。

```bash
npm run evidence:production:preview
npm run evidence:production
```

生成先は`release-evidence/production/admin-sync-package.json`です。デプロイ結果は必須、受入・ロールバック・復旧受入は存在する段階まで自動収集します。

## 3. 管理画面へ同期

production管理画面の「本番証跡ライブ指揮盤」で「証跡JSONを同期」を選び、生成JSONを読み込みます。APIは次をすべて再検証します。

1. v4.0.0と実行Firebase Projectの一致
2. デプロイ8工程の完全な台帳と成功状態
3. パッケージ・証跡・受入runのSHA-256
4. 9検査の順序・重複・欠落・合否
5. 5分間隔3回、デプロイ後30分以内の受入
6. 受入失敗台帳とrollback結果の連鎖
7. rollback成功と既知正常版復旧受入の連鎖
8. 秘密値不在、900KB以下

合格後、管理者と同じ企業IDの証跡要約だけを保存します。クライアント直接書込、別企業参照、進捗巻戻し、同一Releaseのデプロイ証跡差替えは拒否されます。

## 4. 状態

- `DEPLOYED`: デプロイ証跡のみ
- `ACCEPTANCE`: 受入観測中
- `ACCEPTED`: 受入3回合格
- `ROLLBACK REQUIRED`: 受入失敗、rollback待ち
- `ROLLBACK FAILED / LOCKED`: rollback失敗、緊急停止維持
- `ROLLBACK SUCCEEDED`: 既知正常版へ復旧済み
- `RECOVERY CHECK`: 復旧受入観測中
- `RECOVERY FAILED / LOCKED`: 復旧受入失敗
- `RECOVERED`: 復旧受入3回合格

同期は状態が進んだ都度繰り返せます。同じJSONの再同期は冪等、過去状態への巻戻しは拒否されます。
