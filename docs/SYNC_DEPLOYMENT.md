# v0.2 配置手順

## 1. 設定を登録

`config-samples/sheet-import-config.lipknots.json` の `spreadsheetId` を変更し、Firestoreへ次のパスで登録します。

`sheetImportConfigs/lipknots`

最初は以下にしてください。

```json
{
  "enabled": false,
  "scheduleEnabled": false
}
```

## 2. スプレッドシート共有

Cloud Functionsで使用する実行用サービスアカウントを決め、対象スプレッドシートを「閲覧者」で共有します。

環境ごとの暗黙の既定アカウントへ依存せず、専用のユーザー管理サービスアカウントを明示指定する運用を推奨します。

必要権限:

- Google Sheets API
- 対象スプレッドシートの閲覧権限
- Firestoreへのサーバー側アクセス

## 3. デプロイ

```bash
npm install
npm run build
firebase deploy --only functions,firestore:indexes,firestore:rules
```

## 4. プレビュー

管理者画面の「スプシ同期」からプレビューします。

確認項目:

- 対象月タブ
- 読み込んだ案件数
- 募集中・手配済み・キャンセル件数
- 下書き件数
- スタッフ名未照合件数
- サンプル案件の行番号と内容

## 5. 本同期

プレビューが正しければ `enabled:true` にし、Firestoreへ同期します。

この段階でも元スプシへの書込はありません。
