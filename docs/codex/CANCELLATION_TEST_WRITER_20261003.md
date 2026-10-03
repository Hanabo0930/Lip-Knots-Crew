# 取消時の氏名消去・グレー表示：合成専用writer（2026-10-03）

## 今回の範囲

現在の実ソース統合候補は専用 branch automation/cancellation-source-ack-integrated-20261003、保存済みローカル基点 f1a1a20d99d6c751cfd5f506e7bd033913096f94。初期合成writer／overlay候補 automation/cancellation-test-writer-20261003 は別worktreeで保全する。
既存6ファイルのスタッフ復旧PR候補は別worktreeで保全する。今回のモジュールは Functions index、worker、クラウドDB、Sheets/GAS、通知に接続しない。新しいソフト・有料APIを使用しない。

SyntheticCancellationWriter は synthetic_only の架空会社・架空シートIDだけを受け付ける。合成セル配列、ローカル履歴、JSON復旧用チェックポイントで動作する。アプリ管理者認証の実証や本番writerの完成を示すものではない。

## 既存schemaとの対応と重要な選択

- 既存の取消金銭区分 invoice_and_pay / invoice_only / pay_only / neither をそのまま使用する。給与閲覧・給与書類公開の追加は行わない。
- 「依頼なし・誤手配で実施中止、請求0、スタッフ支払10000」の架空ケースは pay_only。取消だけを理由に給与・交通費・会社負担経費を一括0にしない。
- 経費負担者と精算状態は金銭区分に従属させず、今回の履歴に expensePayer=company|pending_review、expenseReconciliation=pending|reviewed を別々に保存する。元の basePay、financials、expenses と物理行の金額・数式を保存・保全する。未確定の実費は null のままにし、支払実行は行わない。
- 旧スタッフID、表示氏名、原本表示氏名を消去前に保存し、連絡対象は会社ID＋旧スタッフIDで保持する。メールアドレス等の実個人情報はテストに投入しない。連絡は manual_contact_pending / not_sent のまま。
- job の assignedStaffId / assignedStaffName はこのwriterで消さない。既存取消identityに担当者が含まれるため、先に消すと意図の照合と日付占有の解放条件を壊す。
- 既存 job.cancel / job.cancel.v2 キューは、取消・理由・v2区分の厳密な値集合と空stylesを維持する。既存workerの許可を緩めない。追加の表示消去計画は同じキューID・案件版・取消identityに固定した後続処理としてモデル化する。
- 月ごとの固定ID列は明示設定を使う。AA/ACの月差、保存済み列との一致、行移動、重複IDを照合する。固定IDなしの場合は保存した行番号を固定する。列の挿入・全月統一・実表変更は行わない。

## 書込みと復旧の契約

1. 会社・admin actor・取消状態・案件版・sourceAck v1・元キュー契約・月別列・行の担当者と勤務情報を照合する。取消済み、募集不可、sourceCancellationClosed が必須。
2. 対象行の before/after、旧スタッフ・連絡対象、独立した金銭/経費処遇を履歴に保存する。
3. 同一ストアの実行権を取る。履歴保存後も案件/キュー/列/方針の固定指紋と物理行を再照合する。
4. 合成CAS一回で氏名空欄・取消チェック/理由/任意のv2区分と明示範囲の背景色だけを変更する。金額、数式、範囲外の背景色を保持する。
5. after を照合した成功だけ complete。応答喪失後は unknown として旧担当者を残す。再送時、after と完全一致なら再書込みせず完了確認する。before と一致すれば一回だけ書く。どちらにも一致しない手修正は停止し、再消去しない。
6. 完了後に行が変更された場合も再送は needs_review として止まり、古い氏名消去を再適用しない。

JSONチェックポイントは上限付きで、内容checksumと固定契約・履歴再構成を照合する。checksumは改変を認証する署名ではない。ファイル改変権限を持つ敵対者への防御や、本番監査基盤の証明として使用しない。実行中のcheckpoint取得は拒否する。

## 日付占有と募集状態

このwriterは sourceAckPending や staffDayLock を解除しない。既存の importedCancellationSourceAck を読取専用でロードし、同じ案件・会社・日付・元タブに対する新しい読取、取消状態、氏名空欄の条件が成立することだけを合成テストした。
初期writer単独段階ではDBの解除トランザクションと業務importerを実行していない。後述の実ソース統合段階では既存importerをメモリDBで実行したが、実SDK／Sheetsの受入は未実施。氏名が空欄になっても募集不可/取消/取引先充足を維持し、自動再募集しない。

## 実施した検証

関連合成ケース27、Functionsの既存strict/noUncheckedIndexedAccessを使った対象モジュールと依存する純粋coreだけのnoEmit。既存Node型定義を明示して使用し、新規依存・設定変更・大規模buildは行わない。

主な検証：v1/v2、金銭4区分、消去前履歴、月別ID列/行移動/重複、会社/権限境界、旧キュー拡張拒否、同時確認、履歴保存後/書込み直前の失敗、応答喪失とディスクcheckpoint復旧、手修正競合、古い版、再送、fresh sourceAck条件。ネットワーク試行0、送信0。
初回の型確認でstrictの存在検査とNode型解決を修正後、同じ関連テストだけを再実行した。既存成功済み全suiteは反復していない。

## 未検証と次工程

- 実際のGoogle Sheets/API、隔離Firestore/SDKのこのwriter用transaction、複数プロセス間の排他・耐久履歴、実認証、通知、原本受入は未実施。
- 合成CASは実SheetsのCASやSheets/DB間の一括原子性を証明しない。実アダプターでは値と背景色の一括要求、限定field mask、実行前後のfresh照合、応答不明時の再読取/手修正検出を別途実証する。
- 実DBの履歴保存/実行権とSheets書込みは同一transactionにできないため、永続intent/排他/復旧確認を設計する必要がある。複数writerの同時更新と、実表を人が編集する競合も未受入。
- シートの氏名空欄と取消確認後に既存importerが担当者の日付占有を解除する連携は、原本を使わない隔離環境で追加受入が必要。
- 次の安全な工程は、この3ファイルの差分レビューと、原本と完全に分離したテストアダプター/受入計画。実業務原本への列・チェック・背景・GAS・送信変更には別の具体承認が必要。


## sourceAck連携の独立レビューと連続遷移受入

Astra・極高の独立狭域レビューで、既存CのsourceAck成功後に旧担当ID/氏名が削除されるため、保存支払額10000が旧スタッフの実績照会・取消履歴から脱落するP1を確認した。実Cのcallable/parser/importer/analytics全体をメモリDBと合成Sheetsに接続した修正前経路でも、保存額10000のまま照会額10000→0を再現した。

今回の候補へ cancellation-history-retention-core.ts と test-cancellation-local-transition.mjs を追加した。既存Cへの接続は source-ack-history-integration.patch / source-ack-history-integration-overlay.json の3ソース（shift-import.ts / analytics.ts / jobs.ts）に限る。元ファイルSHA256・旧文面・出現件数を固定して、同じ実TypeScriptをメモリ上で結合して検証した。このoverlay段階では既存Cの物理ファイルは未変更、結合パッチは未適用である。後述の隔離統合候補には実ソースへ適用済みで、元69差分のworktreeは引き続き未変更。元のスタッフ復旧PR候補6ファイルも保全した。

修正内容：

- fresh ACKまたは保存済みproofが、会社・案件・旧担当・勤務日・元タブ・取消intentへ一致する場合だけ、旧担当を論理上の履歴担当として保持する。
- rawStaffNameは物理氏名空欄、statusはcancelled、publishableはfalse。占有を作る判定は取消状態から行うため、履歴担当が残っても日付占有を再取得しない。
- 保存データ・準備状態・編集revision・募集contextが参照する論理担当を揃える。再取込でも担当・支払照会・取消履歴・版・proofを保全する。
- 既存復帰queueは消去済み氏名を書き戻さないため、物理空欄＋取消閉鎖＋履歴担当の復帰は、proofの有無に依存せず停止する。
- 再レビューで、理由等を変えたv1/v2再取消がproofを置換する追加P1を確認した。同一取消no-op以外の変更は更新前に停止し、元proof・支払・履歴を保つ。正式な理由・金銭区分訂正を行う追記型履歴経路は次工程であり、今回の停止を恒久的な業務ルールとは扱わない。
- v2取消直後もpublishable=falseを明示する。応募直後で原本担当未反映のケースは、氏名照合が一致しない間writerを停止し、占有・支払を保持する。
- 実parserの合成出力を受けるためjob_[a-f0-9]{24}を許可し、既存合成会社IDも受け付ける。synthetic_only・架空会社/シート・合成adminのガードは維持する。

受入した実際の遷移：

assigned → 取消/ACK待ち（占有保持）→ 旧担当/連絡対象の履歴保存 → 氏名空欄/グレー（まだ占有保持）→ fresh取込の原子的job/proof/占有更新 → 同日別案件への応募可能 → 新案件が同日を占有。
旧案件は空欄・グレー・取消・募集不可を維持し、旧取消の再送が新案件の占有を解放しない。旧スタッフの支払10000、basePay、未確定交通費、経費、取消履歴、連絡対象を維持する。

検証は初期7ケース（修正前P1の実処理再現を含む）、追加P1に関する3ケース、最終ガード差分に関係する選択2回帰。最終overlayを含むstrict noEmit成功。既存27ケース・過去の12 SDK条件・全suiteは無条件反復していない。ネットワーク/localhost試行0、実送信0、新規導入0。最終独立レビューでは、このhelperと追加結合差分に残るP0/P1を確認しなかった。

証拠：cancellation-transition-results.json、cancellation-transition-delta-results.json、cancellation-transition-final-regression-results.json、cancellation-source-ack-adapter-result-20261003.json（候補の親evidenceフォルダ）。

## 外部受入の対象・権限・費用の未確認点

- 今回のDBは既存memory/CAS境界であり、実Firestore SDK transactionの受入ではない。過去の隔離runtime記録 demo-lkc-accept-7f0b218a42 / 127.0.0.1:62195 / Firestore 1.21.0 には停止成功の記録がある。今回の起動/ポート状態・既存Java/JARパスは未確認で、再起動や接続はしていない。
- SDK受入へ進む場合は、既存承認済み隔離runtimeの対象と既存バイナリ、localhostのみ、認証探索禁止、合成データのみ、限定したjob/proof/dayLock/audit/履歴のwriteと破棄条件を確定する。新規ソフトやクラウドprojectを作らない。
- 実Sheetsの受入先は未確認。既存承認済みの隔離Spreadsheet ID/tab、固定ID列、許可する氏名・取消・背景の範囲、既存identityのアクセス範囲、新認証なしで使える経路、API割当/費用を親側でまとめて確認する必要がある。対象不明の実表・本番DB・Functions課金呼出しには接続しない。
- 複数プロセスの耐久履歴/排他、実DBと実Sheets間の応答不明時照合、実ログイン・実送信・原本受入は未検証。これらを合成CASの成功で受入済みと扱わない。


## 実ソースへの隔離統合（今回の到達点）

統合場所は指定Cワークスペース内の release-evidence/cancellation-source-ack-integrated-20261003/candidate。保存済みローカルmain f1a1a20d99d6c751cfd5f506e7bd033913096f94 を使い、既存Cの6ファイルに限ったパッチを適用した。さらにレビュー済みwriter/helper/test/docを接続した。元69差分、既存Cの元5ソース、先行スタッフ復旧6ファイル候補、初期overlay候補は保全する。fetchや共有履歴の書換えは行っていない。

この候補の --integrated 受入は、候補の実ファイルを直接ロードする。source overlayによる文字列差替えを行わず、既存callable/parser/importer/analyticsとメモリDB/CAS・合成Sheetsの境界を接続する。

追加の防御と回帰修正：

- 管理者編集が氏名消去確認済みの取消履歴を担当なし／同担当／別担当へ書き換えることを更新前に拒否する。現在のEditSchemaに日付変更入力はないため、helperの日付キーガードを実APIの日付編集受入とは扱わない。
- 理由列が未設定または空欄の取込でも、検証済みの取消履歴の元理由をそのまま保持する。旧v1の同一取消再送が、理由消失によって訂正と誤判定されない。
- 非空の原本理由が元理由と一致しない場合は、fresh ACKと保存proofの両経路でjob/proof/占有を更新前に保持して停止する。周辺空白だけの差を許容し、元の理由文字列は上書きしない。
- 理由／金銭区分訂正や消去済み氏名の復帰は、既存proofを置換する経路を有効にしない。必要な正式訂正・再手配の追記型履歴は別工程。

今回の選択検証は、連続遷移5ケース、担当編集1ケース（3入力）、理由来歴2ケース、影響のある既存C3ケースの累積合格。既存C3ケースの初回ではv1理由消失1件が失敗し、修正後は失敗1件だけを再実行した。理由2ケースの初回は新しい架空の別案件応募を合成行へ反映していないfixtureが停止し、fixtureを修正して2ケースだけを再確認した。最終7モジュールのstrict/noUncheckedIndexedAccess noEmitは成功。過去の27合成ケース、12 SDK条件、全suiteは反復していない。

最終の理由比較・保持と担当編集ガードを独立Astra狭域レビューし、当該追加範囲にP0/P1は確認されなかった。メモリCASでの排他・応答喪失の証明は、native SDK、多プロセス、Sheets/DB間原子性の証明ではない。今回のネットワーク試行・実送信・クラウド／原本変更・新規導入は0。

## 隔離SDK／Sheets受入の具体的な開始条件

過去の承認済みローカルSDK受入は、Java 21.0.12.1、Firestore Emulator 1.21.0、JAR SHA256 c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e。保存された最終対象は demo-lkc-accept-7f0b218a42 / 127.0.0.1:62195 で、shutdown.jsonに停止成功がある。過去12条件の合格は初回10条件と失敗のみの再実行2条件の合計であり、今回の統合ソースに対する実SDK受入ではない。

現在JavaはPATHから見つからず、既知のFirebase emulator cacheパスにも対象JARがない。保存証跡には既存バイナリの絶対パスがなく、現在の起動／port状態も確定していない。全ドライブ探索・新規download／install・認証探索は行わない。既存承認済みJava/JARのC内の実在パスが解決すれば、既存安全runnerとSDK境界を再利用する限定受入を具体化できる。バイナリが失われている場合は、新規導入禁止の条件で停止する。

ローカルSDK受入の対象はdemo project／localhostの専用合成named databaseのみ。job、元取消proof、所有者一致のstaffDayLocks、audit、合成設定／プロフィール／キュー／履歴のテスト書込みに限る。統合候補のソースをロードして、担当・理由・金額保持、再送、新ownerの占有保全、競合時の一括abortを選択する。クラウドFirestore／Functions／業務API、ADC、metadata、実Auth、送信には接続しない。ソフトの実在と隔離条件が不明のまま起動しない。

実Sheetsについては、既存承認済みの隔離Spreadsheet ID、tab、固定ID列、行・列対応、既存writer identityの限定編集権限が見つかっていない。予定操作は「対象の架空行をfresh読取→消去前履歴をローカル保存→同一行の氏名空欄・取消／理由・backgroundのみの限定batch→fresh再読取」。金額・数式・範囲外の色・列／タブ・共有設定は変更しない。Sheets／DBに跨るtransactionはなく、応答不明・他編集・再送の受入が必要である。

実Sheets受入を開始する前に親へ提示すべきexact項目は、隔離Spreadsheet ID/tab/行範囲と固定ID列、氏名・取消・理由・色のfield mask、既存identityと権限、架空データと退避／復旧対象、API割当／費用条件。現時点で実対象と費用は未確認なので、実業務シフト表を代用せず外部操作は停止する。新credential、追加課金、原本変更の承認を既存開発承認から推定しない。

独立して進められる次の必須候補は、既存の取消通知キューを代表の手動「連絡待ち／連絡済」と整合させ、自動送信しない経路と配送ガードをローカル合成で確認すること。今回の統合はその通知運用を変更せず、停止モードを維持する。
