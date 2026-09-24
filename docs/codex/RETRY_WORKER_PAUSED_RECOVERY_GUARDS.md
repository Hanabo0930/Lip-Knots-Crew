# 定期書戻しworkerの停止固定ガード

この変更は、`retrySafeSheetWrites`を停止状態で復旧するための配備保護を追加する。worker配備許可・allowlist・IAM権限を増やさない。現行の配備コマンドは引き続き両sheet workerを対象外として拒否する。

## 実装された保護

- Functions配備用dotenvに`LKC_SHEET_WRITE_MODE=paused`を固定出力する。通知停止も維持し、解除用inputは追加しない。
- `validate-staging-sheet-worker.mjs`をFirebase CLI起動前に実行する。retry単独、固定STAGING/リージョン、停止値・通知値の完全一致、重複・不足・別dotenvの不存在を確認する。
- `processSafeSheetWrite`を含む計画は、旧実行の静止が未証明として拒否する。
- 定期workerをHTTP callable向けのInvoker公開化アダプターから明示的に除外する。作成時の公開化要求・private identity要求を既存IAM処理へ転送せず、workerを含む計画のInvoker更新経路も拒否する。
- workflowの検査ジョブが確認したコミットSHAを出力し、配備ジョブはそのSHAをcheckoutする。ビルド前にもHEADを照合する。

## ソースの検証範囲

既存ソースガードは`retrySafeSheetWrites`について、次の3ファイルをLF改行に正規化してSHA256照合する。判定結果は`SCHEDULED_SOURCE`として表示し、実環境の認証確認とは区別する。

- `functions/src/safe-sheet-writes.ts`: 正規のonSchedule import、5分間隔/Tokyo/300秒、先頭の停止return、sheetSyncQueueのretry_wait/processing処理。
- `functions/src/sheet-write-control.ts`: active完全一致以外を停止する実装。
- `functions/src/index.ts`: exportと固定リージョン。

部分一致やコメントの追加で判定を通さないために、限定復旧候補の全ファイルを固定した。3ファイルの正当な変更でも再レビューとpin更新が必要になる。依存モジュールすべての動作や配備済みIAMを証明する検査ではない。信頼されたmainのガード、通常コードレビュー、既存ビルド・合成試験も必要。

## ローカル検証

```text
node scripts/automation/test-staging-sheet-worker.mjs
node scripts/automation/test-functions-automation.mjs
node scripts/automation/test-staging-notification-pause.mjs
node scripts/automation/test-notification-auth-guard.mjs
node scripts/automation/test-gmail-smoke-automation.mjs
node scripts/automation/test-staging-scope.mjs
```

新規試験はソース改変、停止値欠落/重複/未知値、別dotenv、旧worker混在、異なる環境、版固定、実runnerでのallowlist拒否を確認する。合成ファイルを一時ディレクトリに作り、クラウドや実業務APIは呼ばない。

## 限定復旧案と未実装の配備経路

将来の明示承認対象は、retry Function 1件、対応Cloud Run service 1件、Firebaseが自動作成するScheduler job 1件に限定する。旧workerや別Schedulerは含めない。

現在のshellは定期worker用の配備後分岐を持たず、CLIアダプターも定期workerのInvoker設定を拒否する。このため、allowlistに名前を足すだけでは復旧できない。実配備前には次を順に満たす必要がある。

1. 同一候補SHA・ソース・停止設定・現状の欠落/失敗状態を確認し、退避記録を非公開の作業場所に保存する。
2. Schedulerが使う正確なidentityと既存の有効なInvoker権限を読み取る。追加IAMが必要ならそこで停止し、権限を自動拡大しない。
3. 承認されたidentityだけを扱い、HTTP用の`--no-invoker-iam-check`を実行しない専用配備経路と事後照合を完成させる。これを実装せずallowlistを拡大しない。
4. 指定対象への限定allowlist、停止状態での配備、必要ならScheduler停止をそれぞれ明示承認の範囲へ含める。通常CI・main統合・既存保護環境を通す。
5. 配備後は同じソース、ACTIVE/Ready、Function/Runのpaused値、Schedulerの正しい宛先・identity、Invokerチェック有効・公開binding不存在を読み取り確認する。業務キュー再実行・手動起動・停止解除による動作確認は行わない。
6. FAILED Functionの削除/再作成、追加IAM、想定外の資源変更が要求されたら停止する。失敗時に旧書込みを再開するロールバックは行わない。

onScheduleの配備ではHTTP FunctionとScheduler jobが自動作成される。先頭停止ガードは作成直後から必要となる。[Firebaseの定期実行仕様](https://firebase.google.com/docs/functions/schedule-functions)

稼働中の`processSafeSheetWrite`は別工程。新規到着の静止と旧実行の終了を別々に確認する。Cloud Runのtimeout後も処理が続く場合があるため、時間待ちや新revisionへのtraffic切替だけを終了証明にしない。[Cloud Runのtimeout仕様](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
