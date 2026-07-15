# CHANGELOG v3.2

- stagingとproductionが別Firebase Projectでも安全に承認を引き渡せる署名パッケージを追加
- stagingだけが保持するEd25519秘密鍵で公開判定・復元演習・承認者・対象Projectを署名
- productionは公開鍵で署名を検証し、元Projectと対象Projectの分離を再確認
- 企業ID・鍵ID・公開ゲートfingerprint・復元演習fingerprintを固定
- 発行から30分を超えたパッケージ、未来時刻、別Project、別企業を拒否
- 改ざん、別鍵、対象差替え、公開ゲート再計算不一致を拒否
- 同一パッケージの再取込と再利用をFirestore transactionで拒否
- Projectごとに異なるUIDではなく承認者メールで別管理者条件を再検証
- staging発行・コピー、production貼付・検証・受理・最終実行UIを追加
- 署名判定コア21ケースと秘密鍵非同梱の運用手順を追加
