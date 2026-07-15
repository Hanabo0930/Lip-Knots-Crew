# 通知キュー設計 v0.5

## 流れ

1. 業務処理・リマインダースケジューラーが`notificationQueue`へ登録
2. 静穏時間を判定し`deliverAt`を設定
3. 即時通知はFirestore作成トリガーで処理
4. 未来通知は1分ごとのスケジューラーで処理
5. 対象スタッフ・管理者の有効FCMトークンを取得
6. 最大500トークン単位で送信
7. 無効トークンを自動停止
8. 成功・一部失敗・トークンなし・エラーを記録
9. 一時エラーは指数的に最大5回再試行

## 重複防止

定期リマインダーは会社・対象・カテゴリ・案件・時刻から一意なキューIDを作成します。
5分ごとのスケジューラーが同じ通知を再検知しても、2通作成されません。

## 対象指定

- `targetStaffId`: 対象スタッフの全端末
- `targetRole=admin`: 会社の全管理者端末
- `targetUid`: 特定Firebaseユーザー

## 保存コレクション

- `pushTokens`
- `notificationQueue`
- `notificationSettings`
- `announcementReceipts`
