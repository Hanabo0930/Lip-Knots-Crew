# Sourceへの直接入力：共通月別転記への接続契約

## 現在の実装範囲

案件リストC列に直接入った名前は、既存の `executeCaseListImport` が原本を読み取る際に、`caseListManualObservations/{jobId}` へ非公開の観測記録を保存する。`jobId` は既存の固定案件IDと会社IDから作り、スタッフ名は既存workerと同じ `buildCaseListStaffResolver` で既存スタッフIDに照合する。同名・別名が複数IDへ一致する場合、非稼働スタッフ、数式名、表示値との不一致、取消、既存担当、月別リンクは保留する。

この記録は `LK_CASE_LIST_MANUAL_OBSERVATION_V1` であり、常に `blocked_requires_owner_review`、`selected:false`、`clientNameUpConfirmed:false`、Source/月別の予定書込件数とも0。**転記選択済み・担当確定・月別転記の継続権限ではない。** `SOURCE_PROJECTED`、`SOURCE_WRITE_STARTED`、`SOURCE_MANUAL_OBSERVED` の実行証跡も生成しない。新規担当、勤務日ロック、転記queueを自動作成しない。名前を消した際は `cleared`、行が原本から消えた際は `source_missing` にし、既知の選択済み記録を通常取込で上書きしない。同じ観測の再取込は記録を重複させない。

新規・未担当案件は既存の非公開draft／募集停止のまま。既存アプリ応募の担当・履歴・勤務日ロックは既存保護を維持する。観測時に読んだ65列は値と有効値だけなので、`observedValuesHash` はセル書式・注記を含む完全な書込前スナップショットとは扱わない。将来の選択時には既存のbounded readerで全書込属性を読み直す。

`caseListManualObservations` にクライアント用Rulesは追加しない。既存の最後の `allow read, write: if false` によりクライアント直接アクセスは拒否される。実際の公開・配備・原本操作・GAS・Rules・IAM変更は実施しない。**手入力経路全体は未完了**であり、以下の接続と受入が必要。

## 次に既存管理APIへ追加する契約

画面は既存の「概要 → 書戻しの確認」。アプリ応募と同じ案件単位の「この案件を選択してシフト表へ移行」ボタンとネームアップ済み確認を使う。A列「キャンセル」／BL列「取消」は選択に兼用しない。

推奨APIは既存の `acknowledgeSheetWriteIssue` への厳密な新action。別の転記ライターや別の管理画面を作らない。

```ts
{
  action: "select-case-list-manual-monthly",
  jobId: string,
  observationHash: string,          // 画面で見たprivate観測の64hex
  expectedJobRevision: number,
  expectedSourceRevision: string,
  clientNameUpConfirmed: true,
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
```

これは次段階の**未実装案**。所有者がすでに確認した勤務条件・支給条件を既存の確認機構で再利用し、直接入力済みの案件に `vacancy:true` を要求・保存しない。条件の確認が存在しない／不一致なら、ボタンを有効化しない。`getSheetWriteIssues` はexec向けの安全な案件情報と観測hashを返し、生のSource行、金額計算、私用メモを公開jobへコピーしない。

サーバー側は既存exec本人、会社、停止状態、現在のSource／台帳／月別、スタッフID・active・勤務日ロック、案件revision、観測hash、既存queue／完了receiptを再確認する。取消・コピーID・二重担当・新しいSource変更・同時操作は停止する。選択と条件確認をprivate receiptに束縛し、同じ入力の二重操作は同じqueue/結果を返す。サーバーが安定したqueue IDを決め、`case_list.assign` の既存処理へ登録する。選択API自体はGoogle Sheetsに書かない。

## 同じengineで扱うための証跡変更

- 手入力originをサーバーのprivate選択receiptと登録transactionでのみ確定する。callerの `origin` や「手入力済み」フラグだけで分岐しない。
- 月別workerの前に、原本へ書かずに現在の完全Source／台帳／依存情報を照合した `SOURCE_MANUAL_OBSERVED` をprivate immutable eventへ保存する。Source Cが空欄だった／アプリがCへ書いたという証跡を作らない。
- 手入力originは `SOURCE_PREPARE` / `SOURCE_APPLY` を通らず、同じ既存 `MONTHLY_PREPARE` / `MONTHLY_APPLY` / `MONTHLY_RECONCILE`、adapter、配置・金額・セル保全・最終preflightを使う。
- 現行のCrew向けguardは `SOURCE_INTENT → SOURCE_WRITE_STARTED/DISPATCHED → SOURCE_PROJECTED` とSource revision変化を引き続き要求する。手入力だけ、厳密な新event＋私用選択receiptが揃ったときにSource pre/post同一を認める。全originに対する一律のguard緩和をしない。
- actor UIDは手入力担当本人と選択した管理者を分ける。管理者UIDを担当スタッフのUIDと偽らない。案件・スタッフの照合は固定IDで行う。
- `applicationUnconfirmed` は月別の書込みと読戻し照合ACKまでtrue。選択APIの成功で確定・カレンダー反映にしない。完了後に既存のprivate sheetRef／native ACKと募集停止・履歴状態を保存する。
- 不明な書込結果は既存のowner読取再照合へ。自動再送や重複行追加をしない。

## 残る受入試験

現在の合成試験は、実Source importのpreview無変更、手入力の非公開観測、既存IDへのalias照合、曖昧／非稼働／取消／数式名保留、二重取込、名前削除、行削除、選択済み履歴保全、固定IDコピーの停止を確認する。勤務日ロックや月別queue／原本書込を作らないことも確認する。

次の接続を完成とする前に、実際の新actionから共通workerを通し、選択前停止、選択後転記、readback確定、同時操作、失われた応答、取消、本人一覧・月間calendar、Source/月別二重表示の一貫した隔離試験が必要。表示用の手入力fixture成功を、この経路の受入証拠に代用しない。
