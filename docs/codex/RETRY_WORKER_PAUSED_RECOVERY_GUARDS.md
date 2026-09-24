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
node scripts/automation/test-retry-worker-recovery.mjs
node scripts/automation/test-functions-automation.mjs
node scripts/automation/test-staging-notification-pause.mjs
node scripts/automation/test-notification-auth-guard.mjs
node scripts/automation/test-gmail-smoke-automation.mjs
node scripts/automation/test-staging-scope.mjs
```

新規試験はソース改変、停止値欠落/重複/未知値、別dotenv、旧worker混在、異なる環境、版固定、実runnerでのallowlist拒否を確認する。合成ファイルを一時ディレクトリに作り、クラウドや実業務APIは呼ばない。

## 実装済みの専用経路と実配備の条件

専用経路は実装済みだが、配備allowlistは変更していない。外側runnerと専用runnerの両方で既存の範囲検査を行い、現在はクラウド読取・配備前にretry対象を拒否する。経路の実装・合成試験成功は、実配備の許可や実環境での復旧成功を意味しない。

- `run-staging-firebase-deploy.cjs`から専用runnerへ分岐する。workflowが確認したmainのSHA、実際のHEAD、追跡ファイルの変更不存在、既存の停止値・3ソースのpinを検査する。固定版`firebase-tools@15.24.0`の正規command runnerを使用し、CLIの認証・権限・設定の検査を維持する。
- `run-retry-worker-recovery.mjs`は、固定STAGINGのproject番号、Compute既定identity、FAILED Function、Run/Schedulerの不存在、既存のproject Invoker bindingを読む。identityを推測で補わず、読取エラーを不存在として扱わない。生の環境変数やIAM本文は結果へ出力しない。
- `retry-worker-recovery-core.mjs`は、CLIの計画を1 codebase・1 changeset・retry更新1件に限定する。Function作成・削除、再作成/移行、旧worker混在、IAM変更、API有効化、service account作成、Artifact Registryのcleanup設定変更を拒否する。CLIが要求する既存service agent生成はAPI・IAM構成の照合に置き換える。
- Invoker処理は既存の無条件project bindingの再読取で代替し、IAM書込みへ転送しない。Function更新後、ACTIVE/Ready、同一revision/宛先/identity、両停止値、公開binding不存在、Invokerチェック有効を確認してからScheduler作成へ進む。shellのHTTP向け公開設定は通らない。
- Schedulerは固定名・POST・Functionと同じURI・既定identityのOIDCに限定し、不存在を再確認してcreate APIのみを使う。同時作成で競合した場合も既存jobの上書きは行わない。最後にFunction/Run/Schedulerと既存権限を再照合する。

Invokerチェックの判定はCloud Runの`run.googleapis.com/invoker-iam-disabled`設定、Scheduler作成は`POST /v1/{parent}/jobs`を使用する。[Cloud Runのアクセス設定](https://docs.cloud.google.com/run/docs/securing/managing-access)、[Cloud Schedulerのcreate API](https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs/create)

専用経路導入時の93試験は、固定版CLIのFunction/Scheduler変換と合成の送信先を使い、正常な更新1件・Scheduler作成1件、IAM書込0、範囲外拒否、権限変化、競合作成、事後照合失敗、現行allowlistでの拒否を確認する。ネットワーク呼出しは禁止し、実配備・実業務呼出しは0。CIにもこの試験を追加した。

読取点検で、gcloudの`json(bindings.role,bindings.members,bindings.condition)`が`null`を返し、`spec.template.spec.containers.env`ではコンテナー配列が欠落することを確認した。配列の親を取得する形式へ変更し、IAMは`bindings,etag,version`を保持する。bindingがない有効なサービスpolicyと、読取結果が不明な`null`を区別する。取得情報はメモリ内で検証し、policy本文やコンテナー環境値をログへ出さない。

この実測に基づく合成の再現試験7件を追加し、取得形式修正時点の復旧経路の試験は合計100件。修正前の誤停止と、修正後の停止値・公開binding・条件付き権限・不明policyの検査を確認する。実環境のサービスエージェント読取や有効アクセス確認は別の前提条件であり、取得形式の修正によって権限不足を回避しない。

## Google管理サービスエージェントの構成検証

Google管理のサービスエージェントは利用者project内に作成されず、直接アクセスできない。そのため通常service accountの直接getを成功条件にしない。[Googleのサービスアカウント種別](https://docs.cloud.google.com/iam/docs/service-account-types#service-agents)

PubSub・Eventarc・Cloud Schedulerについて、固定projectから読んだ番号と対応するservice agent member、正確なserviceAgent roleの無条件binding、有効APIを照合する。権限の欠落・別番号・別principal種別・条件付きbinding・該当するdeleted memberの残存・API無効/不明・読取失敗は停止する。Google管理側のdisabled状態、内部ライフサイクル、IAM deny/PABを含む有効アクセス、実際のOIDC呼出し成功の証明には置き換えない。

API状態は`gcloud services list --enabled`から`config.name,state`を取得する。固定版CLIの`ensureApi.check`には永続キャッシュがあるため、この構成検証では使わない。生成要求の受付時に対象APIとbindingを読み、さらに計画受付・Function更新直前・Scheduler作成前・最終照合で3サービスを読み直す。読み取った直後の外部変更を原子的に防ぐものではない。

生成要求の代替は従来どおりPubSub/Eventarcの2つに限定し、Schedulerの生成は許可しない。`generateServiceIdentity`はCLI互換の完了応答、`generateServiceIdentityAndPoll`はvoidを返す。サービスエージェントの直接get、作成、API有効化、IAM書込へのfallbackはない。Schedulerの既存serviceAgent roleは認証トークンの生成に必要な設定として検証する。[Schedulerの認証仕様](https://docs.cloud.google.com/scheduler/docs/http-target-auth)

今回60件の合成試験を追加し、復旧経路の試験は合計160件。直接getの禁止、3サービスのrole/member/API不一致、deleted member、読取拒否、CLIキャッシュが成功でもAPIが無効なら停止、処理途中の構成消失、最終検証の証明範囲を確認する。最終結果の`serviceAgents: api-and-role-bindings-only`は構成検証のみを表す。workerのallowlistは変更せず、実runnerは引き続きクラウド読取前に配備対象を拒否する。

実配備前には、次を別途満たす必要がある。

1. 通常CI・main統合後の同一候補SHAについて、現状の失敗/欠落状態、既存identityと権限を再確認し、退避記録をCドライブの非公開作業場所へ保存する。
2. 限定allowlistと実配備の明示承認を得る。想定する変更はretry Function更新1件、対応Cloud Run service作成1件、Scheduler job作成1件、および正規CLIに伴うソースアップロード・ビルド成果物。旧worker・別Scheduler・IAM拡大は含まない。
3. Schedulerは作成時にENABLEDとなり得るが、Functionの先頭停止ガードにより書戻し・通知を停止する。Scheduler自体の停止を要求する場合は、その操作も別途承認・実装する。手動起動、業務キュー再実行、停止解除は行わない。
4. IAM/API/service agent不足、FAILED Functionの削除/再作成、想定外の資源変更が必要なら停止する。途中失敗では既に更新済みのpaused Functionが残り得る。自動削除や旧書込み再開によるロールバックは行わず、状態を再読取して次の対応を判断する。

完了結果は`paused-configuration-verified`であり、設定の照合結果に限定する。IAM deny等を含む有効アクセスや実際のOIDC呼出し成功は証明しない。専用経路は現行allowlistのため実環境では未実行であり、実復旧と旧worker静止の確認は残る。

onScheduleの配備ではHTTP FunctionとScheduler jobが自動作成される。先頭停止ガードは作成直後から必要となる。[Firebaseの定期実行仕様](https://firebase.google.com/docs/functions/schedule-functions)

稼働中の`processSafeSheetWrite`は別工程。新規到着の静止と旧実行の終了を別々に確認する。Cloud Runのtimeout後も処理が続く場合があるため、時間待ちや新revisionへのtraffic切替だけを終了証明にしない。[Cloud Runのtimeout仕様](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
