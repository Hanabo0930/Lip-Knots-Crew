# 定期通知生成の停止判定

`LKC_NOTIFICATION_DELIVERY_MODE=paused` でも定期生成が通知予約や催促状態を更新していたため、送信処理と同じ判定を `notification-core.ts` に共通化し、`scheduleOperationalReminders` の入口で確認する。

- `active` のみ明示的に動作。空文字・未知値・大文字違いは停止。
- staging は未設定でも停止。従来の staging 以外の未設定時の動作は維持。
- 停止中は設定・案件の検索、通知生成、催促状態の更新を開始しない。
- 停止前に作成された予約は、既存の配信停止試験で保持と未送信を確認する。

## 検証

Functions のビルド後に `node scripts/test-reminder-generation-pause.mjs` を実行する。実際の TypeScript とビルド済み JavaScript の両方を合成データで動かし、環境と停止値を組み合わせた36条件を確認する。修正前は停止すべき26条件が失敗した。実クラウド呼出と実送信は行わない。

この変更はソースとCIの修正であり、既存workerの配備や停止設定変更は含まない。旧実行の終了・イベント受付制御・移行前後の業務互換性は別途確認する。
