# プッシュ通知セットアップ v0.5

## 実装内容

- Firebase Cloud Messaging（Web Push）
- スタッフPWA・管理者PWAの通知許可画面
- 端末ごとのFCMトークン登録・無効化
- フォアグラウンド通知
- バックグラウンド通知用Service Worker
- 通知クリック時の対象画面移動
- 無効になったFCMトークンの自動停止
- 通知テスト

## Firebase Console

1. Cloud Messagingを有効化
2. Web Push証明書（VAPIDキー）を発行
3. スタッフ・管理者の`.env`へ設定

```env
VITE_FIREBASE_VAPID_KEY=YOUR_PUBLIC_VAPID_KEY
```

## HTTPS

Web PushとService Workerを利用するため、本番はHTTPSが必須です。

- スタッフ: `https://staff.lipknots.com`
- 管理者: 管理者用HTTPS URL

## iPhone・iPad

端末とOSの対応状況によっては、ホーム画面へ追加したPWAから通知許可を行う必要があります。
アプリ内では非対応・拒否・許可済みを判定し、利用者へ分かりやすく表示します。

## 導入テスト

1. テストスタッフでログイン
2. 「通知を有効にする」
3. ブラウザの通知許可を承認
4. 「通知テスト」
5. アプリ表示中の通知
6. アプリを閉じた状態の通知
7. 通知をタップして対象画面へ移動
8. 同じスタッフのiPhone・iPad・PCで受信
9. 端末の通知OFF
