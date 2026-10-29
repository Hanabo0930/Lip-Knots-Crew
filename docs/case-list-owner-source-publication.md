# Source公開条件の個別確認と原本ACK

これはsource-only候補であり、実原本書込・実Firestore・GAS・送信・IAM・Runtime配備・停止解除は行っていない。既存原本は読取専用のまま。新経路は従来の `LKC_SHEET_WRITE_MODE` に加え、`LKC_CASE_LIST_PUBLICATION_MODE` が明示的に `active` の場合だけ実行可能で、どちらも未設定・未知値・pausedならqueueを消費しない。設定ファイルの値は変更していない。

## 既存publisherへの接続

`updateJobPublication` を唯一の入口とする。既存のBD=募集中・BE確定済みの確認も、新しいSource変更のACKも、同じ `stageVerifiedCaseListPublication` がjobs公開とprivate `caseListApprovals` を同一transactionで保存する。別HTTP publisher、GAS公開処理、新trigger、新Schedulerは追加しない。

新しいSource変更分岐は **1案件ずつ**。対象は原本「案件リスト」BD=確認待ち、BEがnative空欄、C未手配、BL=falseで、現在の月別連携能力が確認できるものだけ。

| 同じAPIの操作 | 挙動 |
| --- | --- |
| `action: publish`, `sourceTransition.phase: preview` | ownerが明示入力した地域、給与・時間・単日1名・未手配・解消根拠を、現在のSource/台帳版で検証。BD/BEの旧新値と計画hashを返す。書込ゼロ |
| `phase: request` | 同じ計画hashとrequestKeyを再検査し、private REQUESTED・既存sheetSyncQueue・非公開pending案件を同TXで保存。公開成功は返さない |
| `phase: reconcile` | jobに保存されたoperationを解決して読取照合。画面のjob版とintentHashを受けて同じ世代だけを照合し、別タブで作られた新依頼へ切り替えない。呼出者から任意のqueue/原本座標を受け付けない。native POSTなし |
| `action: stop`, `phase: revoke` | 画面のjob版・intentHashをtransaction内で再照合し、WRITE_STARTED前だけその依頼をmetadataで取り下げ。開始後は非公開・永続保留とし、Sourceを自動で戻さない |

入力の対象は `jobIds:[one]`、既存 `expectedRevisions` / `expectedSourceRevisions` / `caseListConfirmations` とする。revoke/reconcileには画面で捕捉した `expectedRevisions[jobId]` と `sourceTransition.expectedIntentHash` を必須とし、古いpaneが新世代を操作することを防ぐ。取り下げ済みの再確認にも最新のjob版を提示する。確認はpreSource版に結び付け、`confirmedRegion` はBE空欄を本人が明示した新値。`reviewPlanHash` と `requestKey` は同じ計画hashを使用する。申告されたnative request、公開案件JSON、private approvalを権限証拠にしない。

管理画面は「案件一覧→募集開始」の一件確認から、原本BD/BEの旧新値を確認して依頼する。ACKまで「原本の公開・照合待ち」。pendingと取消履歴には「原本反映依頼を取り下げ」を別に表示し、取消・月別転記・募集文掲載の選択と共用しない。

## 原本・承認・公開の順序

1. `REQUESTED` はcompany/job/CaseID/owner、preSource binding、before/queued job版、確認条件hash、owner allowlist hash、10分以内の期限、計画hashに結び付く。
2. 同じ `caseListSyncLocks/{companyId}` を取得した後にSourceを再読。既存のbounded compact indexとfull writable 65セルの証拠で、ID重複・台帳・既存月別・対応能力を検査する。
3. immutable `INTENT` に65セルpreimageと予定postimageを保存。native送信前に `WRITE_STARTED` をcreateする。
4. 既存Sheets adapterで、固定IDから取り直した対象行の **BD:BE / userEnteredValueのみ**を1batchだけ送る。HTTP retry・no-response retryは0。
5. native直前とACK読戻しの既存snapshotで同じtransferCapabilityを再検査し、その間に現れた物理月別の同CaseIDも保留する。追加のSheets読取は行わない。再読でBD/BEのnative literal、固定ID、他63セルの値・数式・書式・メモ・validation等と台帳不変を検証する。実際のpostSourceで通常の公開候補検査を通す。
6. 最新job/queue/lease/owner policy/期限・失効を再検査し、共通finalizerによるjobs＋private approval、postSource binding、ACK、queue完了を同TXで保存する。

原本でBD/BEが反映されただけではアプリを公開しない。postSource版のprivate approvalが保存された後に、募集文作成・応募が進められる。応募・直接氏名入力後のネームアップ、本人の別選択、月別ACK、本人確定カレンダーの順序は維持する。

## 保留と再操作

- 同じ依頼は同じqueueへ戻り、異なる条件はpending中に追加発行しない。row番号やセルの色をID・承認に使わない。
- WRITE_STARTED以後の応答不明、timeout、期限切れは自動再POSTしない。lease失効でも永続intent barrierを解除しない。
- 明確なpostimageを期限内に読み戻せた場合だけread-only reconcileでACKできる。取消・停止・失効・owner policy変更は公開を止める。
- WRITE_STARTED前のrevokeは、private proofで未送信を確認してqueueを閉じ、非公開のREVOKEDへする。新しい本人のpreview/requestは新job版の新計画を必要とし、自動再募集しない。
- WRITE_STARTED後のrevokeは非公開・HELD_REVOKEDを維持する。自動rollbackしない。期限切れや取消後などの未解決post-write保留を、別の原本書込で強制解消する契約は本候補に含めない。
- 取込commitはcompany lease取得後にSourceを再読し、未解決publication intentのjobを更新しない。lease前の古いsnapshotで新ACKを上書きしない。
- 通常publish・応募・募集文・復帰にもpending barrierを適用する。取消・停止はjob版を進め、workerが後から再公開しない。

Sheetsのbatchは、人手編集に対するセル単位CASではない。company leaseはアプリ内処理を直列化するが、本人の直接編集を止めない。実受入では対象限定の編集休止時間と、前後の読戻し・異常時の非公開保留を確認する必要がある。

## 変更しない原本と対応範囲

BDの終了、BL取消、Word非現行、台帳手配済み・終了理由・月別リンク、BH非単日、BI group、未確認時間、未対応の研修/OJT/ラウンダー等は保留。BK・金融列・原本の氏名・取消欄・日程方式を補正しない。Aは公開や転記の選択には使わず、現monthly engineが要求する既存native controlとの互換性だけを公開前に検査する。

公開給与は、月別の既存 `checkPromisedPay` をそのまま共有し、owner公開日給とSource AKの確認済み基本給が一致することを、通常公開・募集文・新計画・ACKの前に確認する。差額を推定したり原本金額を変更しない。AF:AJの非zero/不明な追加支給、BMの注意事項は個別公開契約が未対応のため保留する。

BD/BEの既存dataValidationはfull-row内の証拠で検査する。ルールなし、または新値が完全一致で含まれるONE_OF_LISTだけを受理。ONE_OF_RANGE・CUSTOM_FORMULA等の証明に追加読取が必要な条件は保留し、validationを変更しない。

## 隔離検証と今後の境界

actual API/pure planner/state/finalizerの独立試験、actual worker/既存native adapterの単回送信・保全・ACK試験、実trigger/schedulerの両pause境界、既存monthly/native cancellation回帰、Source取込競合、UIのpreview/request/revoke/結果区分を合成環境で検査する。新UIの実DOM試験は既存 `test-admin-workspace.mjs --browser` から実行する。

実装・ローカル試験・正式CI・Runtime配備・実原本での受入は別の完了状態。実原本write activationは未承認であり、隔離候補を作る段階でその承認を先に求めない。実行前にはbook/tab、個別固定CaseID、BD/BEの現在値→本人指定値、実施時間帯・上限・読戻し判定・保留/復元境界を提示する。全体一括変更、GAS、IAM、実送信、停止解除を含めない。
