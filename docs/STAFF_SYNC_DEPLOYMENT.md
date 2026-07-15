# スタッフ名簿同期の導入手順

1. `config-samples/staff-import-config.lipknots.json` のスプレッドシートIDを設定
2. `staffImportConfigs/lipknots` へ登録
3. 最初は `enabled:false`, `scheduleEnabled:false`, `markMissingInactive:false`
4. Cloud Functions実行用サービスアカウントをスタッフ管理スプシへ閲覧者共有
5. 管理画面の「スタッフ名簿同期 → プレビュー」
6. 次を確認
   - 現役スタッフ人数
   - 複数メール人数
   - メールなし人数
   - 無効メール
   - メール競合
   - 氏名以外の情報競合
7. 正しければ `enabled:true`
8. 手動同期
9. ログインテスト
10. 全現役タブの同期が安定した後、必要なら `markMissingInactive:true`
11. 最後に `scheduleEnabled:true`

## 重要

`markMissingInactive:true` は、現役タブから消えたスタッフを利用停止にします。
初回から有効にしないでください。
