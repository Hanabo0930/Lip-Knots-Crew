# v2.4 変更内容

- staging設定を1つに集約する`config-samples/staging-setup.example.json`を追加
- `.firebaserc`・環境JSON・staff/admin/Functionsのenv計5ファイルを自動生成
- previewでは秘密値を表示せず、write時は権限600で保存
- 既存設定の暗黙上書きを拒否し、明示置換時はローカルバックアップを作成
- staging自動構築の正常・危険入力・実書き込みを13ケースで検証
- Firebase runtime、Hosting、Rules、build鮮度、entry chunk、Firebase CLIを事前診断
- デプロイ診断の危険構成6ケースを拒否確認
- `npm run release:staging`でpreflight・staging build・デプロイ診断を一括実行
