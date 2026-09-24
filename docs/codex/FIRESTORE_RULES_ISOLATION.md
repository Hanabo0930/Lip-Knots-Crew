# Firestoreの会社・本人境界の実ルール検証

`announcementReceipts`と`deviceSessions`は会社と本人の両方で閲覧を制限する。管理者の既読記録も自社だけに限定する。`activeStaff()`では参照したstaffProfileの会社がトークンの会社と一致することを確認する。会社情報がない旧記録は他社へ推測で割り当てず、読取を拒否する。

既存の隔離ローカルランナーに`--suite rules`を指定すると、現在の`firestore.rules`を実Firestore Emulatorで読み込み、クライアントSDKのget/query/writeを通す。合成データの準備だけAdmin SDKを使用し、判定対象にAdmin SDKを使用しない。既存の通常業務シナリオは`--suite business`（既定値）で維持する。

```text
node scripts/run-local-firestore-acceptance.mjs --suite rules --java <java21> --jar <pinned-firestore-emulator.jar> --evidence <new-private-directory>
```

既存のdemo project限定、127.0.0.1固定、認証情報除外、外部TCP遮断、JARの固定ハッシュ、証跡上書き拒否、終了処理を共用する。runtime.jsonにはsuiteと使用RulesのSHA256も保存する。CIは通常業務の後に同じJARで別の隔離DBを起動する。

31条件は、会社・本人・役割、会社条件のないクエリ拒否、会社不明の旧記録、失効/停止スタッフ、提出ファイルと同期キュー、直接書込み拒否を含む。修正前は22成功・9不成功で境界欠落を再現し、修正後は31条件すべて成功した。隔離27条件、既存セキュリティ191条件、通常業務9シナリオとFunctionsビルドも成功。

日本語WindowsではEmulatorの拒否メッセージ生成がMissingResourceExceptionとなったため、Javaの言語/地域をen/USに固定する。テストの期待結果は緩めず、permission-deniedを必須にする。

認証claimは合成値であり、実Auth tokenの署名検証・実ログイン・配備済みRulesを証明しない。クラウドへの配備や実データ変更は行わない。Firestoreルールの成功をStorageルールやサーバーAPI認証の証明へ拡張しない。

[Firebase公式：Firestore Rulesのテスト](https://firebase.google.com/docs/firestore/security/test-rules-emulator)

## 古い認証claimと現在の本人登録

authIdentitiesが存在する場合はactiveだけでなくcompanyId/staffIdの一致も要求する。別所属・別本人へ変更された登録や必要項目のない登録は拒否する。authIdentities未作成の従来互換経路は維持するため、この変更を全利用者の再認証保証とは扱わない。

追加6条件の修正前は、拒否すべき会社/本人不一致と項目欠落の4条件が通過した。修正後は既存31条件と合わせた37条件を実Rulesで検証する。サーバーAPIの認証処理や実Auth署名・トークン失効の検証とは別である。
