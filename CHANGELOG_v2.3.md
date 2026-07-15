# v2.3 変更内容

- `.firebaserc`のdefault aliasを廃止し、development・staging・productionを明示分離
- staging設定5ファイルを照合する`npm run preflight:staging`を追加
- 本番Project、live決済、実メール、本番Push、Emulator、サンプル値の混入を自動停止
- スタッフPWA・管理画面・Service WorkerにProject ID実行時照合を追加
- FunctionsにProject ID実行時照合を追加
- staging専用ビルド`npm run build:staging`を追加
- 危険設定5パターンの拒否自己診断を`npm run verify`へ統合
- 各PWAビルド前の安全な`dist`強制削除を追加し、旧ハッシュ資産の残留を防止
- リリース内容のSHA-256一覧を再生成・照合するスクリプトを追加
