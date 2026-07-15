# ログインメール配信

## v0.1

Firebase AuthenticationのクライアントSDKでメールリンクを送ります。

## 本番目標

1. スタッフがメールアドレスを入力
2. Functionsが登録済みメールか確認
3. Firebase Admin SDKでログインリンクを生成
4. staff@lipknots.comからメール送信
5. 1時間以内にボタンを押してログイン

## 必要な追加設定

- Google Workspaceの送信方式
- Gmail APIまたはSMTP Relayの認証
- 送信ドメインのSPF／DKIM／DMARC
- バウンス・送信失敗履歴
- 送信回数制限
