# v2.1 変更内容

- `package-lock.json`の内部専用URLを公開npmへ修正
- ルート・全ワークスペースのバージョン不一致を修正
- GAS監査の修正進捗データを型安全に正規化
- TypeScript 6で停止していたテスト設定8系統を修正
- 全31本のコア回帰テストを一括実行する`test:release`を追加
- ビルド・全テスト・重大度high以上の監査を行う`npm run verify`を追加
- Node 22 CIを一括検証コマンドへ統一
- スタッフPWA・管理画面・Functionsの配布用ビルドを再生成
