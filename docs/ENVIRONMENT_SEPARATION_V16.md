# 環境分離 v1.6

## development

ローカル開発。ダミーデータ。外部送信なし。

## staging

検証コピーのスプシ。テストスタッフ。実メール送信は原則無効。

## production

本番スプシ。本番スタッフ。本番ドメイン。

各環境でFirebase project、スプシID、API Secret、通知送信先を分離します。
本番IDをコードへ直接書きません。

v3.2以降は、stagingに承認署名のEd25519秘密鍵、productionに検証用公開鍵だけを登録します。秘密鍵をproduction、公開鍵をstagingへ共通Secretとして複製せず、承認結果は30分限定の署名JSONで引き渡します。
