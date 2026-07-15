# 本番公開承認・全体停止 v3.0

## 公開順序

1. stagingで30〜50名・3wave・最終観察を完了する。
2. 管理者が10項目と証跡5件以上を確定する。
3. 提出者とは別の`EXECUTIVE_APPROVER_EMAILS`指定アカウントが社長承認する。
4. 社長承認者とは別の管理者がproduction環境で最終有効化する。
5. 有効化直前に段階配布実績とfingerprintを再判定する。

どの段階でも自動公開しない。未達、証跡変更、承認者重複、環境不一致は拒否する。

## 必須条件

- 30〜50名、3wave、対象者全員への配布完了
- 最終監視`CONTINUE`
- 重大アラート、監視失敗、招待失敗が0件
- 本番前バックアップと復元演習
- GAS高・重大リスク0件、staging smoke GO
- 法務・社内規程確認
- 本番Secret、Cloud Monitoring、独自ドメイン・TLS
- データ移行計画、切戻し計画
- 改ざん確認用の証跡参照5件以上

## 全体停止

管理者は理由10文字以上と二段階確認後、全体停止スイッチを作動できる。作動すると`productionControls/{companyId}`が`emergencyLock=true`になり、通知、招待、スプレッドシート書込、行作成、月タブ作成、案件更新、応募、事前連絡、提出、再提出を停止する。

緊急ロックを解除するCallable/APIは実装しない。復旧時は原因修正、証跡保全、復元確認、新しいリリースのレビューを行い、管理者権限でFirestoreを手動変更せず、復旧版の正規手順で再公開する。

## 設定

Functions環境に`EXECUTIVE_APPROVER_EMAILS`をカンマ区切りで設定する。productionでは`APP_ENVIRONMENT=production`と`EXPECTED_FIREBASE_PROJECT_ID`を必須とする。

## 監査コレクション

- `productionReleaseReviews`
- `productionReleaseAuthorizations`
- `productionControls`
- `productionEmergencyEvents`
- `auditLogs`

