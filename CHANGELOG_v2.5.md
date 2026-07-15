# v2.5 変更内容

- stagingリリース時点を`release-evidence/staging/<release-id>`へ自動保存
- ソース・PWA build・Functions build・Rulesをファイル単位SHA-256で固定
- checkpoint manifestとデプロイ結果自体もSHA-256で固定
- actual env、`.firebaserc`、Spreadsheet設定、秘密バックアップをcheckpointから除外
- ファイル改ざん・欠落・追加・重複・パストラバーサルを自動検出
- rollbackは空の隔離フォルダへだけ復元し、現行本体への上書きを禁止
- デプロイ結果、operator、release refs、時刻をcheckpointへ追記可能
- checkpoint・rollback・結果証跡を13ケースで自動検証
