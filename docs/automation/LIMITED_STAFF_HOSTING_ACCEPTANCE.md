# Hosting 限定 Staff 受入

2026-10-20 に承認された、Functions を変更しない限定的な画面・API互換確認の手順。
2026-10-21 の本人承認により、本人による画面観測と技術的な受入を分ける経路を追加した。
初回は専用 Staff のログイン、ホーム内の「今日やること」「次回シフト」の表示までとし、
7 Functions の完全 metadata と前後の配備照合は技術受入へ分離する。
既存の [Hosting 手順](STAGING_HOSTING_AUTOMATION.md) と [AGENTS.md](../../AGENTS.md)
の保護環境・最新 main・正式 CI・固定版復旧条件を維持する。
対象は `lip-knots-crew-staging` / `asia-northeast1` の Staff / Admin Hosting だけ。

## 証明することと残すこと

| 記録 | 意味 |
| --- | --- |
| `PREAUTH_READY` | 新しい同一 SHA の正式 CI / Preview、固定 Hosting 版、匿名初期画面、および選択した方式の認証前安全条件を確認した。技術受入方式だけは7関数の固定配備 metadata も必須。Staff ログイン成功ではない |
| `STAGING_TRIAL` | Preview で認証できない具体的証拠があり、固定した旧 live 2版を保全したうえで Preview の検証済み2版を staging live へ反映した。Staff 受入は未完了 |
| `STAFF_UI_ACCEPTED` | 固定された専用 Staff で認証し、許可した起動経路の応答と画面を実際に確認した。匿名 browser check の成功からは生成しない |
| `STAFF_MANUAL_UI_OBSERVED` | 本人が固定版の専用 Staff ログイン、ホームのToDoと次回シフトの最新表示または正しい空表示を確認した。通信境界、API互換性、Functions配備不変、権限不変、内部副作用は未証明 |
| `sourceAuthenticity: UNVERIFIED` | 配備ソース ZIP とリポジトリの一致は未証明。Function の ACTIVE / GEN2 / nodejs22、Build 成功、revision 固定から真正性を推測しない |
| `submissionAcceptance: UNVERIFIED` | 提出・Storage 送信・Drive 転送・原本への書戻しは未実施。停止中とも正常とも判定しない |

Preview で認証できる場合は `PREAUTH_READY` から選択した方式の結果へ進む。
具体的に認証非対応を確認した場合だけ `STAGING_TRIAL` を経由する。
技術受入の終点は `STAFF_UI_ACCEPTED`、本人観測の終点は `STAFF_MANUAL_UI_OBSERVED`。
本人観測の成功を技術受入へ昇格させず、提出・Drive 転送を含むアプリ全体の完成とも扱わない。
証拠不足・受入失敗はどの段階でも停止し、成功した前段階を後段階の成功として扱わない。

`operation=promote`、workflow 名 `Staging Hosting Promote`、
path `.github/workflows/staging-hosting-promote.yml`、
display title `promote staging Hosting`、artifact `staging-hosting-promote-{SHA}` は維持する。
限定モードは明示的な `evidence_policy=limited-staff-pilot` で指定し、
既定の `source-provenance` を変更しない。自動 Preview からの promote は既定経路のまま。
`check-hosting-api-readiness.py` と `requireNoFeeSourcePath` の厳格経路はそのまま残す。
限定結果を既存経路の `PASS` に変換しない。

## 開発・運用読取・実受入を分けた進め方

以下の1経路を使う。認可読取が止まっていても、独立した通常修正・レビューは進める。
実受入の不足を埋める目的なく個別ブラウザハーネスを追加したり、同じ成功試験を繰り返したりしない。

| 工程・担当 | 完了条件と次工程 |
| --- | --- |
| 1 開発担当：隔離コピーの通常修正 | 実不具合を修正し、変更箇所の回帰と独立レビューを完了する。変更していない既存試験は下記条件で再利用。認可情報の取得やクラウド実行を開発試験へ混ぜない |
| 2 運用担当：既存認可による読取を1回に束ねる | 指定UIDのAuth読取1件と、固定Staff/Adminのliveチャンネル各1件を取得。本文を保存せず、対象一致・権限状態・完全版IDだけを保護された証拠へ残す。未取得項目を真にしない |
| 3 開発・運用担当：公開前条件をまとめて確定 | 工程1・2と並行して、追加費用なし、対象アカウント、選択した観測方式と保証範囲、全試行メール台帳、排他期間・復旧期限を確認する。本人観測のために自作ブラウザ実行器を増築しない |
| 4 開発担当：正規PR/CI/Preview | Actions費用条件が揃えばpush/Draft PRへ進める。統合前に規定のHosting/API/Firestore費用条件を確認する。PRのHEADと統合後mainの新SHAそれぞれに必要なCIを取得し、同SHAの不要な再実行はしない。統合SHAのCI後の自動Previewと自動promoteの1連鎖を管理する |
| 5 本人・運用担当：限定観測 | 準備済み固定版、操作回数、副作用、停止条件、結果の意味を一括提示してから本人が1回操作する。技術受入を選ぶ場合は従来の通信境界を強制する。Preview認証非対応の具体的証拠がある場合だけ、旧2版を保全して通常の保護付きstaging trialへ進む |

工程2・3の未完了だけを理由に、独立した開発や費用条件を満たすDraft PRまで止めない。
実受入は全安全条件が成立するまで開始しない。各工程の許可範囲が別途限定されている場合はその範囲を守る。

既存結果を再利用するには、対象source/dependency/入力fixture/検証方法と、関連するruntime・
実行環境・保護条件が同じで、保存された
exit・結果・digestを確認できることが必要。失敗・未実行・結果不明を再利用で成功に変えない。
コード変更で影響する試験だけをローカルで実行し、変更箇所・再利用範囲をレビューへ渡す。
新しいSHAの正式CIは別条件なので、この再利用規則で省略しない。

最小の運用読取は次の3件。対象projectは常に `lip-knots-crew-staging`。

- Auth：保護記録に固定されたUID1件の `getUser()` 相当の通常読取。
  UID/宛先一致、emailVerified、disabled=false、余分なkeyのないStaff claimsを判定する。
  `accounts:lookup` はPOSTだが読取であり、ユーザー一覧export・認証試行・bootstrapは不要。
  応答には秘密情報を含み得るため、未加工応答や例外全体を表示・保存しない。
- Hosting：`projects/lip-knots-crew-staging/sites/lip-knots-crew-staging/channels/live` と
  `projects/lip-knots-crew-staging/sites/lip-knots-crew-staging-admin/channels/live`。
  `name,release(version(name,status))` を読み、完全な版名と `FINALIZED` を照合する。
  UIの短IDやテストfixtureの版IDを現在のlive証拠へ転用しない。

この3件だけではemailIndex/profileとの実対応、Admin一覧除外、非production環境値、費用、
backup期限は証明できない。既存記録で成立する項目を消し込み、残る対象だけを運用担当へ渡す。
既存 `operation=readiness` はCI/Preview等を要する後段の確認であり、この初期3読取を得るために
起動しない。Functions metadata collectorもAuthやlive版の代替にはならない。

既存認可済み読取接続が無い場合、本人に必要なのは、既に権限を持つ管理端末・管理担当で
上記3読取を1回実施できる場所の確認と、判定結果の受け渡しだけ。
新規key・token貼付・権限追加・ログインやADC作成を要求しない。
既存認可が無ければその工程を停止し、開発工程だけを続ける。
既知の認証DBアクセス拒否を別手段や別保存場所から読み直して解消したことにしない。

技術受入の実行場所は、通常のsandbox付きブラウザ起動、送信前のbody/対象照合、
未知通信拒否、並列要求を含む回数・期限、Service Worker等の遮断、秘密非保存と終了確認を
現在の保護のまま提供できる既存環境に限定する。正規ブラウザの目視操作だけでは代替できない。
自作C launcher/pipeは方式の一例で、正式条件そのものではない。
利用可能な環境で必須機能が成立しなければ、足りない提供機能を明示して運用担当へ返す。
本人観測にはこの自動実行器を要求しない。本人が操作する通常ブラウザの画面観測は、
通信境界を強制した技術受入の代替ではなく、下記の明示された別方式である。
どちらの方式でも、匿名確認や合成試験だけで認証前提の成立や実認証の成功を記録しない。

Hosting adapterのSDK設定は、`retryCodes: []` に加えて `retries: 0` でtransport再試行を止め、
redirectを拒否する。結果不明の書込を自動再送しない。応答本文の通常debugログ抑止には
installed SDKが参照する `skipLog.resBody` を使う。
SDKの通信例外には別のログ経路があるため、この設定だけで秘密非保存を保証したことにはならない。
Hosting adapterへAuth lookup本文を載せる流用はせず、運用読取側で秘匿と再試行なしを別途確認する。

## 着手・公開前に確認する証拠

1. 最新 `origin/main` と今回の HEAD、差分範囲、必要なローカル検証を確認する。
   新しい SHA は新しい正式 CI が必要。過去の SHA の成功は流用しない。
2. Actions の現在の利用枠、保存 artifact を含む追加費用なしの条件を確認する。
   確認不能なら自動 CI を発火する push / PR の前で止める。独立ブランチでの実装・ローカル検証は続行できる。
3. main 統合は自動 Preview を生成するため、統合前に Hosting の残量、配信・保持・rollback版の費用、
   今回の限定 Functions 呼出しと Firestore 読取・ログ記録の費用条件まで確認する。
   billing 変更、課金有効化、購入は行わず、必要な場合は本人判断へ返す。
4. 固定された同一 main SHA の正式 CI と1回の自動 Preview、Preview の run / attempt /
   artifact と Staff / Admin の immutable version を照合する。
   有効期限切れ Preview を新しい証拠にしない。自動生成と手動 rerun を重ねない。
5. 旧 promote `39213378566` は実状態を再読し、対象 workflow / SHA / environment と
   未実行の `waiting` を確認できた場合だけ取消し、`cancelled` を再確認する。
   既に実行開始・結果不明なら取消しを推測で繰り返さず実状態を確認する。
6. 新 auto promote と手動限定 promote は既存の `lkc-staging-hosting-promote` concurrency を共有する。
   待ち行列を別 group で迂回しない。新 run の取消が必要なら対象 run と状態を明示して担当へ返す。
7. `lkc-staging-hosting` の通常保護環境を通す。承認 API が拒否されたら保護を変更しない。
   再評価は関連する新証拠があり、未実行を確認できた場合だけ1回。結果不明の操作を再送しない。

技術受入方式の固定 metadata は API ごとの name / project / region / state / runtime / entry point /
service / revision / traffic と取得時刻を照合し、受入前後で同一配備を再確認する。
7関数の完全情報、前後 GET、10分以内の snapshot 鮮度はこの技術受入の追加条件であり、
原 AGENTS の初回本人画面確認条件ではない。本人方式には要求せず、Functions 配備不変を未証明と記録する。
既存 `collect-upload-metadata` の既定2関数はアップロード経路の診断であり、
Staff 起動 API や実ログインを証明しない。その既定仕様は変更しない。
限定 metadata でもソース ZIP・環境変数全文・Secret・IAM policy 全文を出力しない。

共有 concurrency は外部端末や別 workflow の書込を防がない。backup 開始から受入または復旧完了まで、
外部の Hosting / Functions 更新がないことを確認した排他期間を固定する。
`review.recovery.externalWritersExcluded` と `externalWritersExcludedUntil` はその証拠を表す。
backup channel は現行実装で24時間の TTL であり、任意の長い保持期間を宣言して保証したことにしない。
validator は `retainUntil` を記録作成から24時間以内、受入期限以後に制限する。

## Workflow の入力と保存物

`workflow_dispatch` の `operation=readiness` と `evidence_policy=limited-staff-pilot` は
`PREAUTH_READY` までの読取確認用。staging trial は `operation=promote` と通常の確認語を使う。
両方とも `metadata_only=false`、attempt 1、最新 main の正式 CI / Preview を必須とする。
既定の2関数 metadata 診断に限定 policy を併用しない。
実行の `GITHUB_SHA` と checkout HEAD もその main SHA に一致させる。
待機中に main が更新された古い run で新しい SHA を反映しない。

`limited_evidence` は48KiB以内の JSON。正確な構造は
[`validateLimitedPilotPreflight`](../../scripts/automation/hosting-limited-pilot.mjs) とそのテストで管理する。
費用・専用対象・既存 claims・観測方式（技術受入では通信境界）・メール全試行台帳・Preview 認証可否・復旧と排他期間の
保護された原記録を reviewer が確認し、各 `evidenceDigest` を固定する。
Boolean や digest の形式が合うだけでは事実の証明にならない。合成テスト fixture を実行用の証拠にしない。

原記録、氏名、アドレス、トークン、リンクは入力に入れない。review JSON は runner 一時領域へ保存し、
artifact には Hosting version pin、証拠 digest と判定を残す。技術受入方式だけは正規化 metadata も残す。
技術受入方式の7関数 metadata は GET のみで取得し、反映直前・直後にも配備固定を再確認する。
本人方式は `functions` / snapshot / deployment digest を入力や結果へ作らず、collector と API recheck を実行しない。
検証済み `acceptance_method` で分岐し、方式不明や検証失敗を `skipped` の成功へ読み替えない。
本人方式でも書込直前の Hosting 版、capture、期限、run の確認と正規 manifest・復旧条件は維持する。
どちらも `createUploadSession` / `finalizeStagedUpload` の実行や source ZIP の取得は行わない。
限定 trial は backup 作成/固定と各 live release の POST 直前にも report を読み直し、
期限・run/SHA・対象versionを照合する。途中で期限切れなら残りの反映を止める。
結果が既知の部分反映を旧版へ戻す処理は、期限切れを理由に妨げない。

書込前には同じ正規workflowの過去 promote/restore 履歴も確認する。
未完了run、結果不明の書込み、履歴の欠落を無視して次のtrialを開始しない。
失敗runは書込stepが未実行だったと実証できる場合だけ通過する。
書込開始後の失敗を、現在の画面が旧版に見えることだけで解決済みにしない。
この初期実装には手動の解除flagはない。停止した場合は既存の実行証拠を読取確認し、
未解決結果を解決したと証明できる検査を別途レビューするまで新しい反映を止める。
旧run-name導入以前の成功writerは、現行の成功step証拠と同等と推定せず停止する。
履歴が1000件を超える場合、一覧やjobが欠ける場合、ページ取得中に一覧が変わる場合も停止する。
読取だけの `readiness` にはこの書込履歴gateを適用しない。

workflow の `limited-pilot-evidence.json` は前提証拠の検査結果、
`limited-pilot-trial.json` は反映完了・Staff受入未完了の記録。
`evaluateStaffAcceptance` は別途取得した実認証観測・期限・前後 snapshot を評価する純粋関数であり、
メール送信や実ブラウザ操作を自動実行しない。
本人観測には別の `evaluateOwnerManualObservation` を使う。これも記録の照合だけを行い、
ログイン・メール・証拠のクラウド保存は実行しない。本人観測を既存の API 成功欄へ代入しない。
report は方式別の必須属性・型・未証明状態を再検査する。Staff の実観測は、
Preview なら `checkedAt`、staging なら `trialRecordedAt` 以後でなければ受入できない。
技術受入方式では前 metadata snapshot にもこの順序を要求する。
trial より前に得たログイン結果を staging 受入へ流用しない。

## メール送信前に固定する対象

専用 Staff は既存設定から確認する。アドレスの推測、新規アカウント作成、既存ユーザーの
権限変更で試験対象を用意しない。次の全条件を読取証拠で固定する。

- 社長専用の既存 Staff アカウントであり、既存 Auth ユーザーの email は検証済み。
- emailIndex と staffProfiles が active、companyId / staffId が一致し、本人の専用対象と一致する。
- 配備設定で Admin メール一覧に含まれない。
- Auth の既存 customClaims が **余分な key も含めず**
  `{ role: "staff", companyId: 対象会社, staffId: 対象Staff }` と一致する。
- 対象 UID / companyId / staffId / 宛先を試験全体で固定する。
  公開 artifact には実値を載せず、保護された照合記録の参照と判定だけを残す。

最後の claims 条件は必須。`functions/src/auth.ts` の Staff 分岐も、
既存 claims が一致しなければ `setCustomUserClaims` を実行する。
Admin 分岐は毎回 claims を設定して監査ログと会社の一覧を読み出す。
今回 Auth 設定・永続権限は変更禁止なので、対象確認が曖昧なら bootstrap を呼ぶ前に止める。
ローカルソースの分岐確認だけで、真正性未証明の配備コードの内部動作まで保証しない。

ログイン案内は **全試行を通して最大1通**。Preview / staging / 再試行ごとに枠を戻さない。
送信前に対象・continue URL・送信済み/未送信の台帳を固定し、実行開始時点で1回分を確保する。
応答不明、配送未確認、UI エラーでも自動再送しない。
`requestStaffLoginLink` の `accepted:true` は未登録宛先でも返るため配送証明ではない。
既存ログを読取り、0件・複数・失敗・処理中を送信成功と扱わない。
前提確認時の試行記録は report に保持し、受入記録の先頭と完全一致させる。
件数だけを合わせて既存送信の digest や結果を別の試行へ差し替えない。
トークン、確認コード、メールリンク、メール本文、認証済み storageState はログや artifact に保存しない。

## 現行ソースで確認した Staff 起動範囲

以下は main のソース上の期待契約であり、固定配備のソース一致の証明ではない。
metadata 取得だけでは応答契約やサーバー内部の副作用は検証されない。

| 呼出し | 読取・副作用 |
| --- | --- |
| `requestStaffLoginLink` | emailIndex / staffProfiles、対象の loginLinkRateLimits / loginGatewayTokens / loginInviteDeliveries。案内1通とログイン用記録。code 引数の引換は再送ではなくログイン状態を消費する |
| `loginGateway`（メールリンク経由時だけ） | 対象の loginGatewayTokens、emailIndex、staffProfiles を確認し、openedAt / openCount を記録。production runtime なら productionMetricBuckets も触るため、その状態が不明なら利用しない |
| Firebase Auth | 既存の対象ユーザーに対するメールリンク認証・セッショントークン更新。Admin 認証、新規ユーザー、claims 変更、認証設定変更は不可 |
| `bootstrapSession` | Auth ユーザー / emailIndex / staffProfiles を確認。既存 Staff の lastLoginAt / authUids と authIdentities のログイン記録を更新。claims が一致していることを事前確認する |
| `getMyTasks({})` | 対象 companyId + staffId の jobs（東京日付の過去90日〜未来365日、上限2000）、open resubmissionRequests（上限100）、参照された jobs の追加読取。業務文書は書かない |
| ブラウザの Firestore jobs | 対象会社・本人 assignedStaffId の未来/当日301件、過去51件まで取得し、表示は300/50件。起動後は同じ会社の status=open・当日以降の101件も自動取得する |
| `registerDeviceSession` | 対象 Staff profile と当該 deviceSessions を読取り、その端末の active / lastSeenAt / updatedAt 等を記録 |
| `heartbeatDeviceSession` | 当該 deviceSessions を確認し lastSeenAt を更新。登録直後、5分ごと、画面復帰時に呼ばれる |
| ブラウザの deviceSessions listener | 登録された当該端末1文書を監視する。失効するとローカルのキャッシュ破棄とログアウトへ進む |
| `getPushStatus({})` | 対象 Staff profile と companyId / uid / active に絞った pushTokens を読取り。20件ずつ走査し、表示対象20件に達するまでページングするため総読取数を20件と仮定しない |

主経路は `bootstrapSession → getMyTasks + assigned jobs → registerDeviceSession /
open jobs / getPushStatus`。後半3つは非同期で開始されるため、画面だけ先に見えても技術受入完了にはしない。
この7関数の列挙は本人方式でも想定する起動範囲と副作用の説明であり、各 API の実行や metadata 取得の達成表ではない。
`getPushStatus` は一時エラー時に最大3回試行する。
visibility change は heartbeat に加え push 状態（60秒抑制）と業務一覧（30秒抑制）を再読する。
Service Worker も画面復帰時に更新確認する。通知 listener は起動するが、
通知許可・トークン作成・登録・テスト配信は今回行わない。

`assertProductionOperational` は非 production runtime では業務コントロール文書を読まないが、
production runtime では productionControls を読む。staging project 名だけで runtime 設定を推測せず、
既存の限定された安全証拠で非 production を確認する。値を変更して試験を進めない。

## 技術受入の認証ブラウザ境界

既存 `hosting-browser-check.mjs` は空の browser context で匿名初期画面を検査する。
認証・メール送信・端末登録の試験機ではない。その JSON やスクリーンショットを
`STAFF_UI_ACCEPTED` の根拠に流用しない。

技術受入方式では、認証を始める前に、次の境界を実際に強制・観測できる試験セッションを用意する。
準備したつもりのチェック欄だけで実通信の確認を置き換えない。

1. Staff と Admin は別の空の browser context。既存の Auth / localStorage / IndexedDB /
   Service Worker / 業務キャッシュを取り込まない。
2. Staff の固定 URL、staging Auth、固定された限定 API の正確な endpoint と body、
   Firestore の限定読取だけを通す。未知 endpoint、異なる project / company / Staff、
   任意 URL / redirect、直接の Firestore commit / write は停止する。
   Firestore は POST も読取に使用するため HTTP method だけで判定しない。
   request body の query / document 範囲と SDK の listener 再接続を含めて確認する。
3. `bootstrapSession` は通常の空入力だけ。`refreshDirectory`、Admin 分岐、対象外 callable を通さない。
   `getPushStatus` は `{}` だけで queueId を渡さない。
   端末登録後は返された sessionId 1件だけを heartbeat / listener の対象とする。
4. `getMyTasks` と自動 open jobs 読取を含む実業務情報が画面へ届く。
   読取先・上限・費用の確認ができない場合はログイン前に止める。
   公開証跡は呼出名・成功/失敗・件数・時刻・範囲一致だけにし、
   行本文、氏名、案件情報、Authヘッダー、raw HAR、未加工レスポンスを保存しない。
5. 試験時間と最大通信回数を事前に固定する。home 初期表示の短い観測窓で終了し、
   不要なタブ移動・再読込・長時間放置をしない。heartbeat の初回実行を見落とさない。
   時間切れ・追加リトライ・想定外の visibility 通信は失敗/未検証として止める。
6. 応募、事前連絡、提出、画像選択、下書き保存、再提出、印刷、端末取消、
   通知許可/登録/解除/テスト、管理操作、メール再送を操作しない。
   `createUploadSession`、`finalizeStagedUpload`、Storage upload は停止状態の確認目的でも呼ばない。
7. Admin は既存セッションのない初期画面だけ。ログインボタン、メールリンク、
   Auth state 移植を使わない。Admin 側で認証済み状態や callable が観測されたら失敗とする。

上記は技術受入実施の前提であり、この文書や純粋 validator がブラウザの通信を遮断したり、
サーバー内部書込を自動監視したりするわけではない。
その実行器/手順の証拠が欠ければ認証試験は未実施のまま残す。
ホスト名単位の allowlist、ページを開いて目視するだけ、Functions metadata だけでは不足する。
端末とログイン以外の書込が発生した疑いがあれば試験を停止し、証跡と不確実性を報告する。

## 本人による限定画面観測

本人が通常ブラウザで操作する経路は `acceptanceMethod: OWNER_MANUAL_UI` を明示する。
省略時は従来の技術受入方式であり、通信境界の証明不足から自動で本人方式へ切り替えない。
本人方式の `review.scope.requestBoundaryEnforced` は **false** とし、前提判定でも偽の true を要求しない。
この差は操作主体と保証範囲の違いを表す。Functions、権限、認証設定、Production、転送停止値の
変更、業務書込、追加費用を許可する例外ではない。

費用・専用 Staff / Auth / claims / emailIndex / profile の照合、限定読取と許容書込の範囲、
全試行で1通の台帳、非 production 設定、最新 SHA の CI / Preview、必要時の復旧と排他期間は
技術受入と共通の必須条件として保持する。本人ログインをこれらの事前読取の代用にしない。
本人方式の計画 `review.manualObservationPlan` と承認の保護記録を固定し、1端末・新しい試験用
ブラウザ環境・既存 Staff のメールコード認証1回・1セッション・初期ホームだけ・再送/再読込なし・
秘密非保存を確認する。`observationWindowSeconds` は事前に合意した有限の短い観測時間を秒単位で固定する。
これは本人が認証完了を確認した後のホーム観測開始 `startedAt` から終了 `capturedAt` までであり、
メール待ち時間を含む通信の強制停止期限ではない。前提証拠と復旧の期限は別途守る。
一律300秒上限や観測後10分以内の提出を要件にせず、事前計画・review・trial・復旧の期限で判定する。
これは人の操作計画であり、通信回数、SDK のリトライ、listener、Functions 内部の読取数を
強制する装置ではない。費用確認でも「1画面だから API 1回」「pushTokens は20件まで」と推測しない。

本人への実施案内は、次の一式が揃ってから1回にまとめる。

- 実際に準備済みの固定版と正確な Staff URL、Preview または staging の区別、観測期限。
  ローカル候補、未配備最新版、古い live 画面を最新版として渡さない。
- 専用対象の事前照合、未消費のメール枠または当該固定 origin で利用可能と確認された既存1通、
  観測計画、副作用、停止時の連絡先と復旧担当。メールの消費状態が不明なら開始しない。
- 操作はログイン画面と初期ホームの2画面に限定する。本人に console / HAR / token の取得を依頼しない。
  Admin の未ログイン初期画面は固定版の既存匿名検査で確認し、本人の Admin ログインは不要。

本人の操作は以下の4手順。これは開始依頼ではなく、前提成立後に渡す手順である。

1. 指定された Staff の固定 URL を新しい試験用ブラウザ環境で開く。
2. 事前照合した専用アドレスを入力し、「ログインメールを送る」を1回だけ押す。
   既存1通を使う計画ならこの送信を省略する。別担当からの追加送信も行わない。
3. 届いたコードを同じ Staff 画面へ入力し、「確認コードでログイン」を1回だけ押す。
   メールリンクを重ねて開かず、期限切れ・配送不明・エラー時は再送/再認証せず終了する。
4. 初期ホーム上部のアドレスが専用対象と一致すること、「今日やること」と「次回シフト」の
   最新データまたは正しい空表示、エラーの有無を一度確認して終了する。
   ToDo・「シフトを開く」・「募集案件を見る」は押さず、画面の表示だけを確認する。
   計画時間を超えて待たない。氏名・案件本文・コード・リンクを含めず、結果と開始/終了時刻だけを担当へ伝える。

UI が再読込や再送を勧めてもこの観測では実行しない。応募・提出・画像選択・通知許可・端末取消・
管理操作は行わない。表示エラー、古いキャッシュ、デモ、想定外の対象/画面は観測成功にしない。
ログイン後は一覧読取、端末登録、heartbeat、listener 等が自動で動く。
タブを閉じる操作も全通信の即時停止を証明するものではなく、本人の操作回数と通信回数を混同しない。

本人観測の結果は固定した本人計画、Hosting 版、対象の保護記録、メール台帳に結び付ける。
`sessionStartedAt` は当該セッションの送信/認証開始より前、かつ `checkedAt` / `trialRecordedAt` 以後とし、
その後の home 観測開始 `startedAt`、終了 `capturedAt` の順序を照合する。
既にログインした画面だけを後から観測し、認証前確認を済ませたことにしない。
前後 metadata の run ID・snapshot・digest は本人方式には不要で、技術受入にのみ残す。
本人記録の `homeDisplay` はToDoと次回シフトの表示または正しい空表示、`taskOpened:false` は
タスクを開いていない申告を表す。API応答検査や通信制御の代用にはならない。
同一 workflow 内の本人待機、前後 metadata のための readiness 再実行、自作ブラウザ実行器は要求しない。
`STAFF_MANUAL_UI_OBSERVED` でも技術的な認証受入・API互換・通信境界・事後のclaims不変・
内部副作用と `backendDeploymentUnchanged` は未証明として残す。
見えたことを全API成功や許容範囲外書込の不存在へ読み替えない。
不審な書込や想定外操作の報告があれば停止し、成功観測を記録しない。
本人観測の記録は技術受入の入力や再観測の許可にはならない。技術受入には別途その前提証拠が必要。

## Preview から staging trial へ進める条件

現在のソースは同一 Hosting site の Preview origin を `continueUrl` として許容する。
したがって「Preview の許可をまだ確認していない」は非対応の証拠にならない。

Preview の正確な origin と試験経路に紐づく、既存認証設定の読取結果や具体的な
許可拒否を記録する。単なるネットワーク障害、期限切れ、入力ミス、対象アカウント未確認、
Functions 応答不明、権限が読めない状態を Preview 非対応と分類しない。
権限/IAM/認証設定を追加・変更して試験しない。

Preview でログインできるならその場所で受入する。1通のメールで Preview を試した後、
staging へ別のメールを送ってやり直すことはできない。単一の確認コードや既存リンクも
対象 origin・有効性・消費状態を確認し、書換えや再生成で制約を迂回しない。

staging trial に必要なのは次の全て。

- 同一 current main SHA の新しい正式 CI と有効な Preview、その immutable 2版。
- Preview の具体的な認証非対応の証拠と、既存 staging 設定で同じ専用 Staff を試験できる証拠。
- 未使用または既に消費済みと確定した単一メール台帳、確定した対象、追加費用なしの根拠。
- 両方の現在 live version の固定保存、復旧可能性の照合、期限・保持費用・復旧担当。
- 通常の確認語 `PROMOTE_LKC_STAGING_HOSTING`、既存保護環境、共有 concurrency。

両 live のバックアップ作成・固定版照合は片側の live 変更より前に完了する。
反映成功時は restore が読める正規 manifest を保存し、`STAGING_TRIAL` と受入未完了を記録する。
反映後の匿名 browser check 成功は試行反映の確認に留める。

## 受入、保全、復旧

技術受入では Staff 認証済み・対象 scope 一致・最新一覧の表示・起動 API の実応答・端末記録の範囲内更新を確認し、
受入前後の Function revision と Hosting version が変わっていない場合だけ `STAFF_UI_ACCEPTED` とする。
旧キャッシュ表示や一部 API 失敗を成功にしない。端末記録のための Auth refresh は権限設定変更の許可ではない。
`sourceAuthenticity` と `submissionAcceptance` は、この結果でも `UNVERIFIED` を維持する。
本人方式では前節の観測だけを `STAFF_MANUAL_UI_OBSERVED` として記録する。
どちらの結果もバックアップ自動削除の許可や、次の認証・業務操作の許可を追加しない。

受入前に rollback / Preview channel を削除しない。必要な保持期限内に受入できない場合も、
継続の安全条件を未確認のまま放置せず、固定旧版への復旧を判断する。
限定ルートでは自動の早期 cleanup を行わず、受入後の後片付けは保存した復旧証跡と
対象 channel を再照合した別の安全な操作として扱う。

反映または事後 browser check 失敗は既存の両サイト自動復旧を使う。
技術受入方式の配備再検査、両方式の manifest 確定・artifact 保存の失敗も、
反映結果が既知の場合は同一 run 内で両サイトを復旧する。
不明な反映結果には推測で復旧を重ねず停止する。artifact 保存失敗時は復旧結果を run ログでも確認する。
後続の Staff 受入または本人観測が失敗した場合は、保存済みの成功 promotion run の正規 manifest を使う
既存 `operation=restore` 経路で両方を復旧する。別版へ上書きしていた場合や
run / attempt / SHA / digest / live version が一致しない場合は停止する。
失敗した workflow を成功に書き換えたり、復旧の identity / digest 検査を弱めたりしない。

Hosting を戻しても送信メール、Auth のログイン履歴、staffProfiles / authIdentities /
loginLinkRateLimits / loginGatewayTokens / loginInviteDeliveries / deviceSessions の許可された
ログイン・端末記録は戻らない。それらの削除・巻戻しは実施しない。
現在の transfer paused 値は未確認として保持し、変更しない。

## 報告

変更ファイル、ローカル検証、commit / PR / 正式 CI、Preview / promote / restore の run と SHA、
公開の有無、観測方式と証拠上の現在段階、メール試行回数、未検証項目、残る阻害と具体的な次操作を記載する。
実データ・メール・login / device 記録の操作がなければ明記する。
操作が拒否・待機・結果不明なら、対象、理由、既に完了した範囲を分けて記録する。
旧 main の成功やローカル合成テストを、新 SHA の正式 CI / 実ログイン受入に置き換えない。
