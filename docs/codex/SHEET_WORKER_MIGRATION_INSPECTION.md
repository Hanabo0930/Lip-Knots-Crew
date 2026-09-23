# 書戻しworkerの移行前メタデータ検査

## 目的

書戻しと定期再試行のFunction、Cloud Run、Schedulerが存在するか、同じrevisionを参照するか、停止値が明示されているかを確認する。実行中処理の終了や配備許可を証明するツールではない。

`inspect-sheet-worker-migration.py` は標準Pythonのみを使う。固定STAGING・固定リージョンの5コマンド（Functions describe 2、Cloud Run describe 2、Scheduler list 1）だけを実行する。配備・設定更新・キュー操作・業務API呼出は実装しない。gcloudの既存ログインを使い、ログイン操作や資格情報出力は行わない。

環境変数は `LKC_SHEET_WRITE_MODE` の1キーだけを投影する。認証情報・その他の環境変数・業務文書を取得せず、stderr本文も証跡へ保存しない。返却メタデータと診断結果はローカルの未使用フォルダに保存する。

## 実行

```text
python scripts/automation/test-sheet-worker-migration.py
python scripts/automation/inspect-sheet-worker-migration.py --collect --evidence <新しいCローカル証跡フォルダ>
python scripts/automation/inspect-sheet-worker-migration.py --snapshot <保存済みsnapshot.json> --evidence <別の未使用フォルダ>
```

終了値は0=このmetadata検査で指摘なし、2=不足・不整合・読取失敗あり、1=入力・実行失敗。0であっても `deploymentAuthorized` は常にfalse。CIには合成テストだけを登録し、クラウドの読取はCIで自動実行しない。

## 判定

- 読取失敗・記録欠落・実リソース欠落を区別する。権限不足から「存在しない」と推定しない。
- FunctionsのACTIVE、対応service名、revision、明示的なpaused値を確認する。旧コードが停止値を実装済みかは別検査。
- Cloud RunのReady、Functionとready/created revisionの一致、指定revisionへの100% trafficを確認する。分割・旧tag混在は指摘する。
- retry Schedulerの存在、PAUSED、5分間隔、Asia/Tokyoを確認する。ENABLEDは今回の移行前条件に合格としない。ツール自体はpauseしない。
- 他のSchedulerは名称と状態を別途表示する。その停止・稼働の是非は自動判定しない。
- 現在の配備allowlist外なら指摘する。allowlistを変更しない。

## 移行案で必ず別途扱う事項

1. exact mainと同版CI、停止判定の実配備ソース一致、既存保護環境・Invoker/トリガー認証。
2. 新規イベントの到着抑止と旧revisionの実行終了。timeout経過だけで終了としない。
3. 定期Function配備時のHTTP serviceとScheduler作成、HTTP宛先・認証、停止状態の事後確認。
4. 旧revision/構成の退避、失敗時の中止と復旧。旧版への自動巻戻しで書込みが再開しないこと。
5. 別の原本書込経路・通知作成経路・旧通知。メタデータを読んだだけではキューの安全性は分からない。

実原本は読取専用。既存キューの再実行、一括状態更新、通知の補完・破棄、受付・転送・通知の再開はこのツールの対象外。

## 公式仕様との対応

[Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)では、タイムアウト後も処理したコンテナが終了するとは限らない。待機秒数をdrain完了の証明にしない。

[Firebase scheduled functions](https://firebase.google.com/docs/functions/schedule-functions)では、配備時にScheduler jobとHTTP functionが作成される。欠落サービスの復旧をソース更新だけと見なさない。

スナップショットは取得期間中の観測であり、原子的な全リソース状態ではない。保存後に状態が変わる可能性がある。ソース同一性、実行中件数、Scheduler宛先/IAM、他リージョン、実データは検証しない。配備前には別の許可とガードを必要とする。
