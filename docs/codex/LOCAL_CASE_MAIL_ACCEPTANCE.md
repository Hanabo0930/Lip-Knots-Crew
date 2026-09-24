# 案件メール受信から案件作成までのローカル実DB受入

既存のFirestore隔離ランナーへ`--suite mail`を指定する。ビルド済みのcreateCaseMailReceiver、既存本文解析、createAdminJobGroupを実Firestore SDK/トランザクションで接続する。Gmail取得と認証claimは合成境界であり、実受信・実ログインの受入ではない。

```text
npm run build -w @lkc/functions
node scripts/run-local-firestore-acceptance.mjs --suite mail --java <java21> --jar <pinned-firestore-emulator.jar> --evidence <new-private-directory>
```

5シナリオ：同一メールの同時受信、同じ候補を別操作IDで同時作成、同じ操作の再送と版違い、会社/役割/確認版の拒否、受信停止と実行者失効。受信記録・候補・監査、案件・案件グループ・原文所有記録・作成受領・行依頼の件数を実DBで検証する。通常の下書き/原本未確認を維持し、自動公開しない。

固定ローカルprojectと127.0.0.1、認証情報除外、外部TCP遮断、既存固定JAR、終了確認を共用する。現実の受信boxやシフト表への通信はなく、サーバー本体へ試験専用分岐も追加しない。保存応答が失われる障害の注入や実Gmail配送、実Sheets反映、Security Rulesの検証はこの5シナリオには含めない。
