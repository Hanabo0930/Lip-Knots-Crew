# 案件リストの月別転記前取消

今回の変更はソースと隔離試験であり、原本への書込・配備・停止解除を実行していない。既存 `sheetSyncQueue` の `job.cancel` / `job.cancel.v2` と `processSafeSheetWrite` を使う。別のwriter、GAS、trigger、API、権限は追加しない。

## 対応する境界

2026年11月・12月の、既知のスタッフ1名が割り当てられた月別未転記案件を扱う。

- シート直接入力：既存の非公開 `caseListManualObservations` と同じ担当ID・原文氏名・正規氏名・勤務日・Source版を確認し、owner未選択であることを必須にする。別名・前後空白を含む物理氏名を推測で正規名に置換しない。
- アプリ応募：以前の `case_list.assign` queueと非公開イベントを読み、既存 `assertKnownCaseListContinuation` で `SOURCE_PROJECTED` → owner選択待ち `MONTHLY_PREPARE` の証拠を再検証する。Sourceへの氏名反映前・不明結果・owner選択後・月別intent/WRITE_STARTEDがある場合は保持する。
- 月別転記済み、所属・スタッフ・勤務枠不一致、証拠のない旧依頼はこのSource writerでは扱わない。未割当は後述の別タグの厳密な範囲だけを扱う。月別側の既存取消経路を自動的に完了扱いにせず、勤務枠と履歴を保持する。研修/OJT、ラウンダー、グレイス等を新たに対応済みとしない。

取消受付は既存の管理者APIだけ。CaseListについては両APIでownerが確認したjob版 (`expectedRevision`) の指定と現在版との完全一致を必須にし、担当差替え・画面の古さ・指定漏れをcaptureやdaylock読取より前に止める。管理画面は取消確認に使ったjobの版を送る。CaseList以外の旧API契約は維持する。受付時に割当pointerを消す前の最小比較情報をjobと同じqueueに保存する。これはserver側 `requireAdmin` の会社付き認証で作られた指示であり、caller JSONを権限証拠として採用しない。既存の任意 `authIdentities` が存在する場合は、無効化・別会社を追加で拒否する。private native CellData、元book ID、journal本文を公開jobのcaptureへ入れない。

## 書込と完了条件

既存の停止判定・queue claimより後で処理する。設定の会社/本、固定案件ID、job版、担当ID/氏名/日付、取消指示、所有daylock、原本・台帳版、月別側ID不存在を確認し、既存 `caseListSyncLocks` を取得する。固定IDの重複・行コピーは既存compact indexの検査で停止する。

同じ `caseListMonthlyOperations` の非公開イベントに、65列の元writable CellDataとuser/effective値を `INTENT` として保存する。元値のrevision、物理氏名、BL=false、固定ID、日付と結び付かない再ハッシュ履歴も拒否する。直前に同じ範囲を再読取し、耐久保存した `WRITE_STARTED` を確認してから、Google Sheets `batchUpdate` を1回だけ行う。

| 対象 | 更新 |
| --- | --- |
| 案件リスト C | 氏名のuserEnteredValueだけを消去 |
| 案件リスト BL | userEnteredValueをnative boolean trueへ変更 |

A、BI、K、BM、金額、数式、メモ、書式、台帳、月別タブは変更しない。65列のwritable情報を照合するため、上記2セル以外の同時変更はACKしない。Aは転記選択でも取消ACKでもない。

書込後に新しい原本読取でC空欄・BL=true・同じID/勤務日/台帳・月別不存在と他writable情報の保持を確認した時だけ、同じtransactionで以下を保存する。

- 元の案件ID・歴史担当ID/氏名・取消理由・年間履歴を保持し、`rawStaffName=''` とSource ACKを記録する。
- 同じ案件が所有するdaylockだけを解除し、queueを完了にする。
- `status=cancelled`、`cancelled=true`、募集停止を維持する。取消履歴は既存の非公開履歴範囲に残す。

通常一覧・本人シフト・カレンダーへ戻さない。氏名を復元しない現在の復帰操作と、ACK済み履歴の理由/担当/日付変更は保持する。旧Source-import ACKでrawStaffNameがなかった履歴も同じ保護対象にする。

## 不明結果と旧経路

POSTの応答がなくても再POSTしない。既存の「書戻しの確認 → 保存結果を再照合」(`acknowledgeSheetWriteIssue`, `reconcile-case-list`) から、責任者の読取専用処理を使う。元INTENT・WRITE_STARTED・現在の完全なafter-imageが一致した時だけACKできる。writer設定を停止した後でも、この読取専用照合は可能。Googleの書込clientを構築せず、native requestsは0回。

新native captureを持つ依頼は、旧Source-importの値だけのACKで完了にしない。元のmanual observationも保持し、新writerの完全なCellData照合を迂回しない。native captureがない旧manual依頼では、従来のC空欄・BL=true・新しい読取・同じqueue/actor/会社/owned daylockの検査を通った時だけ、その既読queueも「Source取込で照合済み」として完了させる。native journalの証拠は捏造しない。

native依頼について、dispatch前に人がCを消去しBLを付けた場合、INTENT/WRITE_STARTEDがないので自動ACKしない。この手修正済み依頼のmetadata解決、owner選択後/実行中のSource＋月別両方の取消連携は未完了であり、今回の部分対応を全取消経路の完成とは扱わない。

Google SheetsにはこのFirestore証拠と原子的なcompare-and-swapがない。同一プロジェクトのleaseはAI/アプリ間の競合を抑えるが、人手・他GASの競合を防げない。原本書込を別途許可して試験する際は、対象案件の直前読取から書込・読戻しまで、当該Source行を人手/別GASで変更しない管理が必要。競合・拒否・不明結果は勤務枠を保持し、再書込しない。

## 検証

`node scripts/case-list-tests/test-source-cancellation.cjs` はactual TS worker、既存月別proof-chain、native形のcompact readを使う合成試験。manual/app、v2、12月、別名、1 POST、lost ACK後0 POST読取照合、停止writer、owner選択/月別開始/Source不明の停止、再ハッシュ不整合、メモ競合、別会社・失効actor・lockを検査する。`test-source-io.cjs` は旧Source ACKのqueue完了と、新native依頼を値だけでACKできないことを検査する。実原本・実業務document・実メールは変更しない。


## 未割当 Source 取消の追加範囲（ソースのみ）

既存の両取消API・同じqueue・同じnative helperに `LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2` / `assignmentMode=UNASSIGNED_SOURCE` を追加する。担当済みV1の条件は緩めない。管理者が現在版を確認して取消した後、原本反映までは `sourceAckPending=true` を保持する。

対象は2026年11月・12月の通常案件・単日・1名枠で、Source Cがnative空欄、BLがnative false、BKが `headcountConfirmed=true`、同じ固定IDの未手配台帳行が正確に1行、月別に同じIDが存在しない案件だけ。Cの式による空欄・空白文字・氏名chip、研修/OJT・ラウンダー・出口調査・グレイス等、複数日・group link・台帳不存在は保持する。台帳不存在を不存在の証明とみなさない。

| 取消前状態 | 必要な公開世代の証拠 |
| --- | --- |
| 未募集 `draft` | 公開pointerなし、Source BD=`確認待ち` |
| 公開済み `open` | 同じSourcePub世代のREQUESTED・INTENT・WRITE_STARTED・ACK、完了queue/operation、Source post版とACK hashの一致、BD=`募集中` |
| 公開前に取り下げた `draft` / `stopped` | 同じ世代のREQUESTED・REVOKED、`afterWriteStarted=false`、WRITE_STARTED/ACKなし、BD=`確認待ち` |

公開pointerはcompany・job・固定ID・hashとともに耐久captureへ固定し、各authorizeと最終ACKで同じ非公開世代を再照合する。公開がpending/HELD/HELD_REVOKED、公開世代の置換、開始後の取下げは保持する。新しいSourcePub ACKのない旧公開経路のopen案件も対象外。公開時の人手確認だけでBKが未確認のままの案件は今回保持する。

新タグではスタッフID/氏名/UIDはnull。スタッフprofileとdaylockの読取・作成・解除を行わない。原本65列のfull CellDataを耐久保存して直前再照合後、既存Sheets transportへ**BLだけの1 POST**を行う。Cは空欄表現・書式・メモを含めて書き換えず、BD/BE、台帳、月別、金額、数式、その他の列も更新しない。完全なafter-imageを確認したときだけACKし、確認結果を `origin=UNASSIGNED_SOURCE, staffId=null` と保存する。

結果不明時は再POSTせず、既存ownerの読取専用照合で同じINTENT・WRITE_STARTED・完全after-imageが一致した時だけ完了する。writer停止中でもこの読取照合は可能。未割当取消の会社年間依頼数は元案件として残し、架空スタッフを作らず、スタッフ別件数へ加算しない。通常募集・シフト・カレンダーから外したまま、自動再募集しない。pending・結果不明・ACK済みのいずれも理由・担当・日付の上書きと取消復帰を拒否し、未解決の取消証拠の消失や原本BL=trueと矛盾する復帰を防ぐ。

検証は `test-unassigned-source-cancellation.cjs` がactual両APIから同じnative helperまでを通す。公開/取下げ世代は既存SourcePub worker/APIを使った同じ合成原本で生成する。外部書込・配備・本番試験・停止解除は実施していない。Google Sheetsの人手/GASとのCAS制約と無編集期間の運用要件は担当済みV1と同じ。

## 同一案件を引き継ぐ接続試験

`node scripts/case-list-tests/test-connected-owner-journey.cjs` は同じ合成Source/台帳/月別とFirestore mapを使い、工程間でjob・private承認・担当を作り直さず、SourcePub workerの実ACK出力を募集文の実validatorへ渡す。そのまま実応募API、またはSource Cの手入力を実取込adapterへ渡し、本人の選択前停止、ネームアップ未確認の拒否、選択後の月別worker/adapter/ACK、本人selectorとカレンダー項目、通常案件一覧からの除外まで検査する。

11月・12月×応募・手入力の4経路が月別ACKへ到達し、同じ組合せの別4経路は転記選択前の管理者取消APIからSource取消ACK・本人非表示・私的な年間依頼数の保持まで検査する。応募の同一request再操作と月別/取消workerの再操作でも重複行や再POSTを発生させない。Google/Firestore SDK・認証境界は合成transportであり、実認証・Rules・実原本の通し受入とは別の証拠である。選択後・月別転記済みのSource取消を対応済みにする試験ではない。
