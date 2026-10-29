# Source直接入力と共通月別転記

## 入力と選択の順序

案件リストC列へ直接名前を入れた案件は、**既存の案件リスト同期／取込commit**で観測する。新しいonEdit、GAS配備、自動トリガー、連携有効化は追加していない。単にC列を編集した瞬間にアプリを更新する実装ではない。

観測後は既存スタッフ名簿と同じresolverで固定スタッフIDへ一意に照合し、既存の勤務日ロックとともに「確認待ちの手配」を保存する。案件IDは固定IDと会社から導出する。公開jobの担当名はSourceの文字列をそのまま保ち、正規プロフィール名は `caseListManualPending.canonicalStaffName` とprivate情報へ分ける。aliasをスタッフIDに使わず、管理者UIDをスタッフUIDと偽らない（`assignedUid:null`）。この段階では転記queue、月別書込、Source書込、選択済みreceiptを作らない。確定シフト・次のシフト・カレンダーへは出さない。

本人がクライアントへネームアップした後、管理アプリ **「概要 → 書戻しの確認 → この案件を選択してシフト表へ移行」**で案件と5項目の勤務・支給条件を確認する。A列「キャンセル」／BL列「取消」は転記選択に兼用しない。選択API自体もGoogle Sheetsへ書かず、既存 `case_list.assign` の同じ月別engineへ登録する。書込みと読戻し照合ACKが揃うまで `applicationUnconfirmed:true` を維持する。

## 観測と担当保護

`caseListManualObservations/{jobId}` は既存default-deny Rules下の非公開観測。`LK_CASE_LIST_MANUAL_OBSERVATION_V1` は選択権限や月別継続証跡ではない。値・有効値のhashを、書式・注記を含む全CellDataのhashと取り違えない。選択時は既存bounded readerで完全なSource・台帳・月別・依存情報を再読込する。

曖昧な同名・alias、非稼働、数式名、表示値不一致、取消、別担当、既存月別リンク、未対応案件は保留する。待機担当の作成時もtransaction内で現在のプロフィール・alias・会社・active、既存勤務日ロックの所有関係を再確認する。同じ観測は重複せず、名前・日付変更時に古い担当とロックを勝手に取り替えない。名前削除は観測を `cleared`、行削除は `source_missing` にし、既知の担当・履歴を保持する。

選択済み観測はprivate receiptとして残し、正しいqueue・スタッフIDに結び付いている場合は通常の同一Source再取込で上書きしない。cancelled状態の未担当行もdraftへ戻さず、募集停止を維持する。新規研修・OJT・ラウンダー・出口調査・グレイス、複数日、2026年11／12月以外、未対応金額・配置・数式は受入済みと扱わない。

## 既存APIのmanual action

`acknowledgeSheetWriteIssue` に厳密なmanual actionを追加。別の月別ライターは作らない。

```ts
{
  action: "select-case-list-manual-monthly",
  jobId: string,
  observationHash: string,
  expectedJobRevision: number,
  expectedSourceRevision: string,
  clientNameUpConfirmed: true,
  manualConfirmation: {
    confirmedFields: {
      arrival: true, execution: true, headcount: true,
      dateMode: true, payOffer: true
    },
    payOffer: {
      dailyWageJPY: number,
      travelExpenses: "全額支給",
      communicationExpenses: "全額支給"
    }
  }
}
```

既存exec本人だけが実行し、会社・actor・停止状態・Source／台帳／月別・スタッフID・プロフィール・本人の勤務日ロック・案件版・観測hashを再確認する。既存の公開用空き枠承認を流用せず、manual条件には `vacancy` を持たせない。支給日額は現在Sourceの計算値と共通controllerで照合し、不一致で止める。二重操作は安定したqueueIDとprivate request hashで元の受付結果を返す。未知の結果を自動再送しない。

`getSheetWriteIssues` のmanual issueは `operation:"case_list.manual"`、`manualSourcePending:true`、観測hash・現在job/source版・安全な案件情報を返す。私用メモや原本の管理JSON・生金額計算は公開jobへ入れない。`manualCursor`／`manualNextCursor` で会社別にページングし、古い選択済み観測に新規手配を隠させない。

## 共通engineの証跡

manual assignmentは `LK_CASE_LIST_MANUAL_ASSIGN_V1` / `SOURCE_MANUAL`。登録transactionがprivate条件承認・選択receipt・完全65列の `SOURCE_MANUAL_OBSERVED`・pending queueを原子的に保存する。元Sourceは既に手入力されているので、`SOURCE_INTENT`／`SOURCE_WRITE_STARTED`／`SOURCE_PROJECTED` を偽造せず、Source prepare/apply/reconcileの呼出しを禁止する。

manualは同じ `MONTHLY_PREPARE → MONTHLY_APPLY → MONTHLY_RECONCILE`、adapter、配置・ID・金額・セル保全・最終preflightを使う。Crewの空欄C書込と変更後Source証明は従来どおり必要。manualだけ、厳密なprivate観測・選択・条件・hashが揃うときSource pre/postが同一であることを許す。混在したCrew Source書込証跡は拒否する。

月別ACK後のprivate参照・金融読取も同じmanual証跡を検査する。read-only owner復旧は既存monthly intentとwrite-startがあるときだけ読戻しへ進み、Sourceを書き直さない。ACK応答不明・途中停止は二重書込せず保留する。

## 取消と受入の境界

取消受付は本人への直接連絡のみ。アプリの管理者取消は通常表示・再募集を止める。Sourceに名が残るpending手配ではSource確認が終わるまで勤務日ロックを解放しない。まだ月別選択していないmanual手配に限り、既存Source取込が取消後の新しい原本で固定ID・日付・ネイティブ取消チェック・C氏名空欄・同じ台帳・現在取消queue・元revision/identity・正しい所有ロックをすべて読戻し確認した場合、共有 `importedCaseListCancellationSourceAck` を通して既存のSource ACK証跡を保存し、本人のロックだけを解放する。古い読取・名が残る行・別queue・別所有ロックは保持する。月別選択済み／書込不明の手配はSourceだけで解放しない。元Sourceへ取消・氏名消去を書くnative adapterは、この変更で新たに有効化・配備していない。Source取消の実書込、既存GASの本番稼働、原本や権限の変更は別であり、アプリの取消メタデータ成功をnative取消ACK成功とは報告しない。

ローカルでは実Source importer、既存管理API、manual登録、共通worker／adapter、private ACK／金融参照を合成Google／Firestore境界で検証する。名前だけで月別0書込、選択後の月別1書込・Source0書込、実readback public ACK、二重操作、alias、取消、名簿・ロック・Source変化、不明ACKのread-only回復、混在証跡拒否を含む。正式CI、公開／配備、実原本の運用受入は別々に報告する。新IAM・Rules・GAS・本番変更や実データ操作の追加許可とは扱わない。
