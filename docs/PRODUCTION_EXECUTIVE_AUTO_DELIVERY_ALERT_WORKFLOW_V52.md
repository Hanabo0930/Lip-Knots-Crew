# v5.2 経営レポート自動配信・分析アラート運用

## 自動配信

- `runProductionEvidenceOperationsDigest`が60分ごとに判定します。
- 毎週火曜09:00 JST以降、直近8週の経営レポートを`ADMIN_EMAILS`へ1回だけ配信します。
- 同一週の`weekKey`と`deliveryKey`で重複配信を防止します。
- 配信結果、対象週、判定、リスク点、配信先数をイベントと監査ログへ固定します。

## 分析アラート操作

- 操作前に最新8週データを再集計し、画面の指紋と一致する場合だけ更新します。
- 「確認済みにする」は確認者、時刻、理由を保存します。
- 「担当固定」は`ADMIN_EMAILS`内の担当者だけを許可し、本人へ通知します。
- Firestoreクライアントからの直接書込は拒否します。

## PDF

- 「PDF出力」でA4印刷画面を開き、送信先に「PDFとして保存」を選びます。
- レポート本文とタイトルはHTMLエスケープしてから印刷画面へ渡します。

## 本番前確認

1. Node.js 22で`npm ci --ignore-scripts`と`npm run verify`を実行する。
2. `ADMIN_EMAILS`の全員が対象企業の管理者で、Firebase Authへ登録済みか確認する。
3. 実Firebase productionへデプロイ後、火曜配信・確認・担当通知・PDF保存を確認する。
4. 失敗時はv5.1.0の既知正常bundleへ別承認rollbackする。
