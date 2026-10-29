# 案件リストの月別転記前取消

今回の変更はソースと隔離試験であり、原本への書込・配備・停止解除を実行していない。既存 `sheetSyncQueue` の `job.cancel` / `job.cancel.v2` と `processSafeSheetWrite` を使う。別のwriter、GAS、trigger、API、権限は追加しない。

## 対応する境界

2026年11月・12月の、既知のスタッフ1名が割り当てられた月別未転記案件を扱う。

- シート直接入力：既存の非公開 `caseListManualObservations` と同じ担当ID・原文氏名・正規氏名・勤務日・Source版を確認し、owner未選択であることを必須にする。別名・前後空白を含む物理氏名を推測で正規名に置換しない。
- アプリ応募：以前の `case_list.assign` queueと非公開イベントを読み、既存 `assertKnownCaseListContinuation` で `SOURCE_PROJECTED` → owner選択待ち `MONTHLY_PREPARE` の証拠を再検証する。Sourceへの氏名反映前・不明結果・owner選択後・月別intent/WRITE_STARTEDがある場合は保持する。
- 月別転記済み、未割当、所属・スタッフ・勤務枠不一致、証拠のない旧依頼はこのSource writerでは扱わない。月別側の既存取消経路を自動的に完了扱いにせず、勤務枠と履歴を保持する。研修/OJT、ラウンダー、グレイス等を新たに対応済みとしない。

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

native依頼について、dispatch前に人がCを消去しBLを付けた場合、INTENT/WRITE_STARTEDがないので自動ACKしない。この手修正済み依頼のmetadata解決、owner選択後/実行中のSource＋月別両方の取消連携、未割当Sourceのnative取消は未完了であり、今回の部分対応を全取消経路の完成とは扱わない。

Google SheetsにはこのFirestore証拠と原子的なcompare-and-swapがない。同一プロジェクトのleaseはAI/アプリ間の競合を抑えるが、人手・他GASの競合を防げない。原本書込を別途許可して試験する際は、対象案件の直前読取から書込・読戻しまで、当該Source行を人手/別GASで変更しない管理が必要。競合・拒否・不明結果は勤務枠を保持し、再書込しない。

## 検証

`node scripts/case-list-tests/test-source-cancellation.cjs` はactual TS worker、既存月別proof-chain、native形のcompact readを使う合成試験。manual/app、v2、12月、別名、1 POST、lost ACK後0 POST読取照合、停止writer、owner選択/月別開始/Source不明の停止、再ハッシュ不整合、メモ競合、別会社・失効actor・lockを検査する。`test-source-io.cjs` は旧Source ACKのqueue完了と、新native依頼を値だけでACKできないことを検査する。実原本・実業務document・実メールは変更しない。
