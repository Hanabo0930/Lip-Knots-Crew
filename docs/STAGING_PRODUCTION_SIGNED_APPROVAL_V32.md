# staging→production署名付き承認 v3.2

## 目的

stagingとproductionを別Firebase Projectに分離したまま、段階配布・復元演習・公開審査・社長承認の結果だけを改ざん不能な形で引き渡します。Firestore文書のコピーや共通Admin SDK権限は使用しません。

## 鍵の分離

1. オフライン端末でEd25519鍵ペアを生成する。
2. 秘密鍵はstagingの`APPROVAL_PACKAGE_SIGNING_PRIVATE_KEY`だけへ登録する。
3. 公開鍵はproductionの`APPROVAL_PACKAGE_VERIFY_PUBLIC_KEY`だけへ登録する。
4. 両環境の`APPROVAL_PACKAGE_KEY_ID`を同じ値にする。
5. stagingの`PRODUCTION_FIREBASE_PROJECT_ID`をproduction Project IDに固定する。

生成例:

```bash
openssl genpkey -algorithm ED25519 -out approval_private.pem
openssl pkey -in approval_private.pem -pubout -out approval_public.pem
```

秘密鍵ファイルはZIP、Drive、Git、管理画面へ保存しません。Secret Manager登録後は社内鍵管理規程に従って隔離保管または安全に破棄します。

## 実行順

1. stagingで30〜50名3wave、復元演習、公開審査、社長承認を完了する。
2. 「署名パッケージを発行」を押す。
3. 生成されたJSONをproduction管理画面へ貼り付ける。
4. productionで「検証して受理」を押す。
5. 社長承認者とは別メールの管理者が30分以内に「本番公開を有効化」を押す。

## productionの拒否条件

- Ed25519署名不一致、鍵ID不一致、schema不一致
- 発行元がstaging以外
- sourceとtargetが同一Project
- targetが実行中production Projectと不一致
- ログイン管理者の企業IDとパッケージ企業IDが不一致
- 公開ゲートが不合格、またはSHA-256 fingerprint再計算不一致
- 復元演習fingerprintがSHA-256形式でない
- 発行時刻が未来、30分超のTTL、期限切れ
- 同じパッケージIDの再取込、使用済みパッケージの再利用
- 緊急全体停止ロック中
- 社長承認者とproduction最終実行者のメールが同一

## 監査証跡

- staging: `productionApprovalPackageExports`
- production: `productionApprovalPackages`
- 最終権限: `productionReleaseAuthorizations`
- 全操作: `auditLogs`

署名JSON自体に秘密鍵は含まれません。ただし承認情報を含むため、監査証跡としてアクセス制限された`05_監査・移行`へ保存します。
