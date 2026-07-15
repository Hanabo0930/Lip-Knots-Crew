# CHANGELOG v3.7

## 本番Firebaseセットアップ

- `production-setup.json`から8つの本番設定を一括生成。
- Firebase Project、staff/admin Hosting、Web App、Functions環境、署名承認、13 Metric typeを一本化。
- Windows用ダブルクリックウィザードを追加。初回は入力JSON作成、2回目は検査・生成・非破壊診断を実行。
- 管理画面に本番セットアップフロー、8生成ファイル、JSON出力、コマンドコピーを追加。

## 安全性

- 実値保存前の完全検査とサンプル値残留拒否。
- Project・Hosting・App・URL・Metric・メールの分離・形式検査。
- 改行注入、private key、Service Account、client secret、access/refresh tokenの混入拒否。
- 既存ファイルの暗默上書き禁止、明示置換時の全件バックアップ。
- POSIXでの入力・出力権限600と一時ファイル経由の原子書込。
- 生成後もFirebaseデプロイは自動実行せず、診断とコマンドpreviewで停止。

## 検証

- 本番セットアップウィザード25ケース。
- 管理画面の新パネルを含む本番ビルドとワンクリックデモ検査。
- v3.6までの41本のコア回帰を維持。
