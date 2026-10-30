# Dot接続用：案件リストから本人シフトまで

2026-10-30。11月開始に向けた既存実装の接続仕様。アプリ担当はこの仕様と現在mainを照合し、別のpublisher・月別writer・取消writerを追加しない。これは本人がDotへ渡すための資料であり、Dotへの送信や確認応答の取得は行っていない。

## 完了区分

| 区分 | 現在地 |
| --- | --- |
| 既存の業務ソース | PR239/244/245/246が統合済み。通常単日1名、2026年11月・12月の応募／手入力とowner選択、月別ACK、本人表示、転記前取消を実装 |
| 接続試験 | 同じ合成Source・台帳・月別・Firestore mapを工程間で作り直さず、11月/12月×応募/手入力の転記4経路と選択前取消4経路を検証。PR246の正式CI40856844607と統合後main CI41008368108は全3成功 |
| Staff容量 | PR247の既存診断遅延読込を採用。追補PR248は構成ありのAdmin/Staff両方を既存上限で検査。head f768ba6c4a8748f1c33aa95bdc70b3bc04cd345eの正式CI41012368310全3成功、通常merge 0b40ada2d52d8d389093c3c91ac513a64539c3ae |
| シートの募集入口 | PR249の候補。既存GAS入口を固定Admin画面への案内へ変更し、同じ募集文生成を利用。35隔離条件PASS。最終headの正式CI・通常統合・統合後mainをPRで確認すること |
| 実反映 | 今回のGAS・Functions・Rules・索引・Live反映と停止解除は未実施。原本業務セル・業務Firestore・実メールを変更していない |
| 実運用受入 | 未完。ソース試験／CIの成功を、実Auth・実環境・実原本の成功と混同しない |

## 使用する画面と同じAPI

| 工程 | 操作場所・既存処理 | そこで確定してよい状態 |
| --- | --- | --- |
| 案件の確認・募集開始 | 管理「案件 → 案件一覧 → その他の操作 → 募集開始／募集条件を再確認」、`updateJobPublication` | 現在Source/台帳/固定ID/地域/単日1名/公開日給等とprivate承認を確認。Source変更が必要な場合は同じAPIのpreview→request→worker→reconcile。Source原本ACKまで公開待ち |
| 募集文 | 管理「案件 → 案件一覧 → 募集メールを作成」、`generateJobExport({purpose:"recruitment-draft",...})` | 地域を1つ、1〜20件を「募集文に掲載」で選択。件名／本文コピーごとに同じserver validatorで再照合。文面生成・コピーは送信完了ではない |
| 募集 | 本人が既存のメール環境で送信 | 自動送信は追加していない。送信済みという状態を生成APIの成功から推定しない |
| アプリ応募 | Staffの既存応募画面、`applyToJob` | 応募受付・確認待ち。同じrequestIdとjob/source版を使い、既存daylock/本人ID/会社照合へ進む。Cへの氏名反映後もowner選択待ちで停止 |
| Cへの手入力 | 原本「案件リスト」Cへ本人が入力後、既存の「連携を有効化・案件を取込」で観測 | 同じ名簿resolverで既存staffIdへ一意に照合。確認待ちと勤務枠のみ。onEdit即時同期・転記済みreceipt・月別queueは作らない。現時点では実原本取込commitを実行する許可はない |
| ネームアップ | 本人がクライアントへ連絡 | アプリは完了を推定しない。名前入力／応募／募集文の選択から代行しない |
| 月別への選択 | 管理「概要 → 書戻しの確認 → この案件を選択してシフト表へ移行」、`acknowledgeSheetWriteIssue` | 本人が案件の日付・店舗・担当とネームアップ済みを確認して明示選択。手入力では勤務条件5項目と日給も確認 |
| 月別保存 | 同じ`case_list.assign`／`MONTHLY_*` engineとnative adapter | 書込受付だけで確定しない。完全なreadback ACKまで`applicationUnconfirmed:true` |
| 本人表示 | Staffの確認待ち一覧／確定シフト／アプリ内カレンダー | 月別ACK後だけ確定へ表示。日付・店舗・メーカー・業務・入店・勤務時間・住所を表示し、不明値は「確認中」。Google Calendar連携ではない |

シート入口候補は`lkRmV1Open`等の既存名とonOpen呼出しを維持し、`https://lip-knots-crew-staging-admin.web.app/?entry=recruitment-mail`への案内だけを表示する。queryに案件ID・氏名を載せず、認証完了後に案件一覧と募集panelを開くだけ。地域・対象・作成・コピー・公開・転記は自動実行しない。実反映の2ファイルと私的book-binding1設定は [GAS変更案](recruitment-sheet-entry-review.md) を参照。Hostingの実反映とAuthの受入も別工程。

## 月別選択のAPI契約

アプリ応募は`getSheetWriteIssues`から得た現在のissueを使う。同じ既存APIへ次を送る。

```ts
{
  queueId: issue.id,
  action: "select-case-list-monthly",
  reviewKey: issue.manualTransferReviewKey,
  clientNameUpConfirmed: true
}
```

直接手入力は同じ画面から`action:"select-case-list-manual-monthly"`を使う。`jobId`、`observationHash`、`expectedJobRevision`、`expectedSourceRevision`、`clientNameUpConfirmed:true`と、arrival/execution/headcount/dateMode/payOfferの5確認・公開日額・交通費/通信費全額支給を送る。詳細な型は [手入力仕様](case-list-manual-origin.md) と実`ManualSourceTransferConfirmation`を使用し、公開jobsからprivate証拠を合成しない。

「募集文に掲載」は文面専用、「この案件を選択してシフト表へ移行」は転記専用。Source A、BL、取消操作、確認メモ、再試行は転記選択の代わりにならない。選択APIはGoogle Sheetsへ直接書かず、共通engineへの権限付き指示を保存する。

## ID・セル・履歴

- 固定案件IDはSource BI、11月月別BC、12月月別BD。既存staffId・会社・勤務日・job/source版・private receiptを照合する。行番号や表示名からIDを作らず、行コピーによる重複ID・同名/別名の衝突・古い版・別会社・勤務枠競合は停止。
- Source B:BCの54業務列を月別A:BBへ対応付け、手入力金額・備考/メモ・セル注記・書式・入力規則・テキスト書式/チップを保持する。数式は検証済み参照だけを変換し、未知/動的参照や計算エラーは停止する。新規月別AS/ATの報告書/原本チェックは未チェックに初期化。12月の追加BC列とSource原行は保持する。
- 月別ACKが会社・案件・スタッフ・日付・queue・Source版・月別参照と一致した案件だけを通常案件/募集一覧から外し、「月別へ転記済み（履歴）」へ残す。Source物理行の削除や非表示は行わない。
- 再操作は既存idempotency/lease/immutable journalを使う。書込開始を耐久保存した後は単回送信・retry0。不明結果を再POSTせず、`action:"reconcile-case-list"`で同じ証拠と実readbackだけを確認する。成功に見せる合成ACKは製品に追加しない。
- 取消受付は本人への直接連絡のみ。既存の管理者取消APIは現在job版を要求する。通常一覧/募集/本人シフト/カレンダーから外し、非公開の年間依頼数に元IDと歴史担当IDを保持。自動再募集・原行削除・架空staff生成をしない。

## 未対応と接続前に残る条件

1. owner選択後・月別開始後・既転記案件のSource＋月別取消は未完成。現在は保留して勤務枠を保持する。Source取消helperのV1/V2は転記選択前だけ。月別には専用取消列があると推定しない（最新読取の11月BC/12月BDは固定ID列）。
2. 研修/OJT/ラウンダー/出口調査/グレイス・複数日/複数枠・対象外月・人数不明・追加手当/公開注意事項の未対応条件・不明な金額/数式は保留。通常案件の対応へ数えない。
3. 既存worker移行のreadonly inspect 40828168301はScheduler一覧GET403で停止。原因のpermission/roleは未確定。新IAMや別identityで迂回せず、同じidentityで実権限証拠を確認する。固定ソース退避・writer来歴・到着保持/旧実行と外部書込の終了・保留依頼復旧の独立証拠も未完。
4. 取消非公開化のソースは実装済み。読取監査の矛盾0は確認されたが、索引READY→対応App→Rulesの実反映と旧cache/本人拒否の受入は未完。過去通知一括変更やデータ補正は含めない。
5. 原本は読取専用。GAS重要変更、原本業務書込、実送信、停止解除、新権限、本番/Liveは一般の継続指示から許可を推定しない。GASは上記2ファイル/設定の具体的な案を実行前に本人へ提示する。

## Dot側で照合する受入

同じ合成案件を使い、(a)地域を選んで募集文、(b)応募と手入力の両入口、(c)名前だけで月別0書込、(d)ネームアップ未確認の拒否、(e)本人選択後だけ月別1書込、(f)再操作で重複0、(g)月別ACK前は確認待ち、(h)ACK後の本人カレンダー必要項目、(i)通常一覧と月別履歴の二重表示なし、(j)転記前取消・本人非表示・私的年間数の保持を確認する。

既存試験は`scripts/case-list-tests/test-connected-owner-journey.cjs`、`test-source-cancellation.cjs`、`test-unassigned-source-cancellation.cjs`、既存募集文/公開DOM試験、`test-recruitment-sheet-entry.mjs`。これらを再実装せず現在mainの試験へ接続する。実原本/実Authの通し試験は許可された対象・実施時間・上限・前後照合・不明結果の保持条件を別途確定してから行う。

進捗正本はMASTERの案件58/82行、変更・検証履歴の当該案件行と、PR249。ソース・隔離試験・正式CI・配備・実運用を別々に記録する。
