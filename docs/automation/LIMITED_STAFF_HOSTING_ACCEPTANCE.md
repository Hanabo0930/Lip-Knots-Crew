# Hosting 限定 Staff 受入

2026-10-20 に承認された、Functions を変更しない限定的な画面・API互換確認の手順。
既存の [Hosting 手順](STAGING_HOSTING_AUTOMATION.md) と [AGENTS.md](../../AGENTS.md)
の保護環境・最新 main・正式 CI・固定版復旧条件を維持する。
対象は `lip-knots-crew-staging` / `asia-northeast1` の Staff / Admin Hosting だけ。

## 証明することと残すこと

| 記録 | 意味 |
| --- | --- |
| `PREAUTH_READY` | 新しい同一 SHA の正式 CI / Preview、匿名初期画面、限定範囲の固定配備 metadata、および認証実施前の安全条件を確認した。Staff ログイン成功ではない |
| `STAGING_TRIAL` | Preview で認証できない具体的証拠があり、固定した旧 live 2版を保全したうえで Preview の検証済み2版を staging live へ反映した。Staff 受入は未完了 |
| `STAFF_UI_ACCEPTED` | 固定された専用 Staff で認証し、許可した起動経路の応答と画面を実際に確認した。匿名 browser check の成功からは生成しない |
| `sourceAuthenticity: UNVERIFIED` | 配備ソース ZIP とリポジトリの一致は未証明。Function の ACTIVE / GEN2 / nodejs22、Build 成功、revision 固定から真正性を推測しない |
| `submissionAcceptance: UNVERIFIED` | 提出・Storage 送信・Drive 転送・原本への書戻しは未実施。停止中とも正常とも判定しない |

Preview で認証できる場合は `PREAUTH_READY → STAFF_UI_ACCEPTED`。
具体的に認証非対応を確認した場合だけ `PREAUTH_READY → STAGING_TRIAL → STAFF_UI_ACCEPTED`。
証拠不足・受入失敗はどの段階でも停止し、成功した前段階を後段階の成功として扱わない。

`operation=promote`、workflow 名 `Staging Hosting Promote`、
path `.github/workflows/staging-hosting-promote.yml`、
display title `promote staging Hosting`、artifact `staging-hosting-promote-{SHA}` は維持する。
限定モードは明示的な `evidence_policy=limited-staff-pilot` で指定し、
既定の `source-provenance` を変更しない。自動 Preview からの promote は既定経路のまま。
`check-hosting-api-readiness.py` と `requireNoFeeSourcePath` の厳格経路はそのまま残す。
限定結果を既存経路の `PASS` に変換しない。

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

固定 metadata は API ごとの name / project / region / state / runtime / entry point /
service / revision / traffic と取得時刻を照合し、受入前後で同一配備を再確認する。
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

`limited_evidence` は48KiB以内の JSON。正確な構造は
[`validateLimitedPilotPreflight`](../../scripts/automation/hosting-limited-pilot.mjs) とそのテストで管理する。
費用・専用対象・既存 claims・通信境界・メール全試行台帳・Preview 認証可否・復旧と排他期間の
保護された原記録を reviewer が確認し、各 `evidenceDigest` を固定する。
Boolean や digest の形式が合うだけでは事実の証明にならない。合成テスト fixture を実行用の証拠にしない。

原記録、氏名、アドレス、トークン、リンクは入力に入れない。review JSON は runner 一時領域へ保存し、
artifact には正規化した metadata、Hosting version pin、証拠 digest と判定だけを残す。
7関数の metadata は GET のみで取得し、`createUploadSession` / `finalizeStagedUpload` の実行や
source ZIP の取得を行わない。反映直前・直後にも配備固定を再確認する。

workflow の `limited-pilot-evidence.json` は前提証拠の検査結果、
`limited-pilot-trial.json` は反映完了・Staff受入未完了の記録。
`evaluateStaffAcceptance` は別途取得した実認証観測・期限・前後 snapshot を評価する純粋関数であり、
メール送信や実ブラウザ操作を自動実行しない。

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
open jobs / getPushStatus`。後半3つは非同期で開始されるため、画面だけ先に見えても完了扱いしない。
`getPushStatus` は一時エラー時に最大3回試行する。
visibility change は heartbeat に加え push 状態（60秒抑制）と業務一覧（30秒抑制）を再読する。
Service Worker も画面復帰時に更新確認する。通知 listener は起動するが、
通知許可・トークン作成・登録・テスト配信は今回行わない。

`assertProductionOperational` は非 production runtime では業務コントロール文書を読まないが、
production runtime では productionControls を読む。staging project 名だけで runtime 設定を推測せず、
既存の限定された安全証拠で非 production を確認する。値を変更して試験を進めない。

## 認証ブラウザの実行境界

既存 `hosting-browser-check.mjs` は空の browser context で匿名初期画面を検査する。
認証・メール送信・端末登録の試験機ではない。その JSON やスクリーンショットを
`STAFF_UI_ACCEPTED` の根拠に流用しない。

認証を始める前に、別途、次の境界を実際に強制・観測できる試験セッションを用意する。
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

上記は受入実施の前提であり、この文書や純粋 validator がブラウザの通信を遮断したり、
サーバー内部書込を自動監視したりするわけではない。
その実行器/手順の証拠が欠ければ認証試験は未実施のまま残す。
ホスト名単位の allowlist、ページを開いて目視するだけ、Functions metadata だけでは不足する。
端末とログイン以外の書込が発生した疑いがあれば試験を停止し、証跡と不確実性を報告する。

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

Staff 認証済み・対象 scope 一致・最新一覧の表示・起動 API の実応答・端末記録の範囲内更新を確認し、
受入前後の Function revision と Hosting version が変わっていない場合だけ `STAFF_UI_ACCEPTED` とする。
旧キャッシュ表示や一部 API 失敗を成功にしない。端末記録のための Auth refresh は権限設定変更の許可ではない。
`sourceAuthenticity` と `submissionAcceptance` は、この結果でも `UNVERIFIED` を維持する。

受入前に rollback / Preview channel を削除しない。必要な保持期限内に受入できない場合も、
継続の安全条件を未確認のまま放置せず、固定旧版への復旧を判断する。
限定ルートでは自動の早期 cleanup を行わず、受入後の後片付けは保存した復旧証跡と
対象 channel を再照合した別の安全な操作として扱う。

反映または事後 browser check 失敗は既存の両サイト自動復旧を使う。
配備再検査・manifest 確定・artifact 保存の失敗も、反映結果が既知の場合は同一 run 内で両サイトを復旧する。
不明な反映結果には推測で復旧を重ねず停止する。artifact 保存失敗時は復旧結果を run ログでも確認する。
後続の Staff 受入が失敗した場合は、保存済みの成功 promotion run の正規 manifest を使う
既存 `operation=restore` 経路で両方を復旧する。別版へ上書きしていた場合や
run / attempt / SHA / digest / live version が一致しない場合は停止する。
失敗した workflow を成功に書き換えたり、復旧の identity / digest 検査を弱めたりしない。

Hosting を戻しても送信メール、Auth のログイン履歴、staffProfiles / authIdentities /
loginLinkRateLimits / loginGatewayTokens / loginInviteDeliveries / deviceSessions の許可された
ログイン・端末記録は戻らない。それらの削除・巻戻しは実施しない。
現在の transfer paused 値は未確認として保持し、変更しない。

## 報告

変更ファイル、ローカル検証、commit / PR / 正式 CI、Preview / promote / restore の run と SHA、
公開の有無、証拠上の現在段階、メール試行回数、未検証項目、残る阻害と具体的な次操作を記載する。
実データ・メール・login / device 記録の操作がなければ明記する。
操作が拒否・待機・結果不明なら、対象、理由、既に完了した範囲を分けて記録する。
旧 main の成功やローカル合成テストを、新 SHA の正式 CI / 実ログイン受入に置き換えない。
