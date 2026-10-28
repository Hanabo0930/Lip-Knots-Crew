# Case list source integration

## Required acceptance before release

PR239 remains Draft and unmerged while the following acceptance gaps are resolved. Passing its current synthetic tests and CI does not establish native activation or the complete operational journey. No new IAM, Rules deployment, production or GAS change is authorized by these requirements.

| Requirement | Current evidence and remaining gap |
| --- | --- |
| Explicit selection after client name-up | Crew assignment pauses after Source C. Selection is the management app's **概要 → 書戻しの確認 → この案件を選択してシフト表へ移行** button with a case-specific name-up confirmation. Source **案件リスト A列「キャンセル」** is cancellation only; no sheet checkbox is used for transfer selection. |
| Both input paths | Crew application path has synthetic coverage. Direct typing of a name into Source has no production manual driver yet; it is incomplete and must use the same transfer controller, not a second native writer. |
| Pending versus confirmed and calendar | `applicationUnconfirmed` stays true until monthly readback ACK. Staff pending applications now have a separate confirmation-wait list and are excluded from upcoming/past confirmed lists and the next-shift summary. The loaded records remain available for refresh/recovery. Synthetic display fixtures cover both origins; these do not establish manual intake acceptance. The requested calendar is the in-app monthly display, not Google Calendar. The in-app monthly calendar now renders loaded confirmed shifts with day details and month navigation. Full native readback-to-display acceptance remains open; pagination is explicitly disclosed. |
| No double display | Monthly ACK closes recruitment. Admin normal lists now exclude only CaseList records with matching verified public ACK identities, Source revision and destination reference; explicit monthly-transferred history retains them. Missing/stale proofs stay visible for review. Cancellation uses its own explicit history view. The physical Source row currently remains present; no physical row hiding or Source-state mutation is claimed. |
| Identity and cell preservation | Existing controller checks stable case/staff IDs, duplicate destination IDs, journal/lease ownership and full writable Source snapshots. Both input paths and copied IDs still need combined acceptance. Only supported ordinary single-day, one-person November/December 2026 cases are in scope. Training, OJT, rounder/exit survey, Grace and unsupported financial cases remain held. |
| Owner-only cancellation and private history | Existing cancellation callables require admin and active lists filter cancellation. Retained cancellation assignees can still satisfy the jobs read rule, so a hidden UI alone is not private history. Owner-only history, annual unique request counts, list exclusion and no automatic reopening need a shared existing-flow implementation; do not silently change permissions. |
| Isolated acceptance and status reporting | First CI failed due to old auth schema recognition, a two-card fixture assumption and stale worker source pins. Those were corrected and head685ed1 passed all three checks. New acceptance must cover application/manual entry, stop before selection, selected transfer, duplicate actions/IDs, cancellation and staff display. Report local tests, CI, publication/deployment and real operation separately. |

Implementation must preserve the existing monthly transfer engine and its fail-closed journals. Any change beyond the existing authorization must be presented with its effects before execution.

The existing authenticated `previewShiftImport` and `syncShiftSheetsReadOnly` callables accept `source: "case-list"`. The source workbook, sheet identity, 65 headers and time zone are server pinned. The separate CaseList import path creates drafts and retains existing assignments, unresolved applications and day locks. Known historical monthly links are held instead of duplicated.

The source revision binds all 65 source user-entered/effective values and the corresponding 25-column assignment ledger record. Public jobs contain only safe business fields, public pay conditions and hashes. Source rows, mail, contacts, management JSON and raw financial values are never copied into public job documents. Owner confirmations are stored in `caseListApprovals`, covered by the unchanged default-deny Rules.

Verified executive identity is required to enable the source or confirm a publication. A new application uses the existing `applyToJob` transaction, day lock and idempotency receipt. The request, receipt and typed `case_list.assign` queue bind the source revision. A previously accepted request returns its saved result before reading a newly changed source. Known precommit source rejection carries an exact request identity so the staff UI can discard only that unaccepted attempt. Unknown network outcomes retain the same retry identity.

Assignments remain disabled by default. The dedicated monthly route is integrated into the existing worker ahead of its legacy pause guard; it requires a separate company opt-in and respects the global operational stop. Historical queued writes remain paused. Owner setup derives November BC and December BD from their actual headers and refuses conflicting saved mappings. Unsupported monthly layouts, dates, identities or formulas are held before publication and application.

An accepted application retains its staff day lock and stays unconfirmed while the worker projects only its exact empty Source C cell. It then stops in a visible `owner_transfer_required` state before any monthly intent or write. Staff-name entry, application acceptance, source checkboxes, scheduled retries, read-only reconciliation and confirmation memos cannot transfer it or hide that new arrangement.

The required order is **staff-name entry → client name-up → owner selects the case → monthly transfer**. The verified executive must use the case-specific transfer action and explicitly attest that client name-up is complete. No client message is sent by this action. The server binds a private selection receipt to that queue, actor, assignment and current Source content/revision. It wakes only the selected queue and performs no Sheets write in this action. The actual Source A header is `キャンセル`: transfer selection never uses or changes that checkbox, and checked cancellation holds the case. All 65 Source writable cells and the complete projected catalog must remain unchanged. The native adapter verifies the trusted receipt and Source again immediately before writing. Unselected cases remain waiting.

Only after that separate owner action can the worker insert one new monthly row with the same Source case ID. Source is retained. Full snapshots, selection receipts and immutable stage records stay private. Public jobs expose safe fields and a minimal readback receipt. This change wires the existing Crew assignment queue; the direct Source-only manual driver remains inactive and must adopt the same trusted selection gate before release.

The worker executes one known phase per invocation with at most two bounded native snapshots. A private continuation nonce and journal proof authorize each next phase. A durable write-start record is persisted before each Sheets mutation, and SDK write retries are disabled. An unknown or interrupted write is held rather than re-dispatched. The owner’s “保存結果を再照合” action uses Sheets reads only; exact current source/monthly afterimages can settle private receipt and application metadata. A source-only result remains held for a separate reviewed continuation. A confirmation memo cannot acknowledge the native application.

Compact reads cover complete identity and layout indexes but full writable fields only for the selected source and destination. Unknown cells remain explicitly unknown. Monthly reimport can refresh an accepted row hint only when the original private receipt, book, sheet, case and assignment still match; it cannot clear a Source-missing hold. Source business edits hold preparation without changing assignment, history or manual values. New CaseList financial reads use current verified private observations, and unsupported expense completion or business edits return an explicit hold.

Validation: `node scripts/test-case-list-integration.mjs` runs source, callable, compact-reader, staged-worker, private-reference, resync and recovery tests with fully synthetic data and mocked Google/Firestore boundaries. The release workflow also runs authorization mutations, built CJS asset closure and `node --max-old-space-size=128 scripts/test-case-list-runtime-budget.mjs` with the actual installed SDKs. These checks do not prove native cloud authentication, network latency, deployment or business execution. Full TypeScript and application builds run in the ordinary CI. Before deployment and opt-in, the exact release commit must pass CI, runtime capacity and native acceptance. The authenticated executive action remains available after those release gates, while its flag stays absent or false until explicitly enabled.

## 7項目の照合結果と残る受入試験（2026-10-28）

選択画面は **管理アプリ「概要 → 書戻しの確認 → この案件を選択してシフト表へ移行」**。案件単位の確認で「クライアントへのネームアップ済み」を本人が確認する。案件リスト A列「キャンセル」と BL列「取消」は転記選択に使わない。案件IDは案件リスト BI列、11月月別 BC列、12月月別 BD列で照合し、名前の文字列だけではスタッフを決めない。同名・別名が複数のスタッフIDへ一致した場合は停止する。

### 引継ぎ範囲

現在の共通転記エンジンは案件リスト **B:BC の54業務列を月別 A:BBへ対応付ける**。手入力金額、備考、メモ、セルの注記、書式、入力規則、テキスト書式・チップ情報を保持する。数式は値へ置き換えず、検証済みの参照変換だけを行い、未知の参照・動的参照・数式エラーは停止する。例外として月別 AS/AT の「報告書チェック／原本チェック」は新規案件として未チェックに初期化する。Sourceの管理列や取消チェックを月別の業務列へコピーしない。固定案件IDは月別の専用列へ書く。12月の追加列 BC は保持し、管理領域を推測で埋めない。元の案件リスト行・数式・メモは転記時に削除しない。

通常の単日・1名・2026年11月／12月以外は完成対象に含めない。研修、OJT、ラウンダー、出口調査、グレイス／グレース、未対応の金額条件・複数日程・経費完了は保留する。

### 追加実装の接続条件（まだ受入完了ではない）

- **直接入力**：C列の名前を既存スタッフIDへ一意に解決し、既存の案件ID・勤務日ロックと照合して同じ選択画面へ渡す。直接入力済みのC列を「空欄へアプリが書いた」と偽って既存の書込証跡へ流さない。月別の別ライターは作らない。現在この本番アダプターは未接続。
- **確定表示**：既存の `applicationUnconfirmed` を月別の書込み・読戻し照合ACKまで維持する。選択受付・書込み開始・応答不明の段階で解除しない。スタッフの「確認待ちの応募」は確定一覧と次のシフトから分離済み。カレンダーはアプリ内の月間表示を使用し、Google Calendar連携は追加しない。月間表示は読込済み確定シフトから表示し、月移動と日別の店舗・メーカー・メニュー・入店時間・勤務時間・住所を追加。確認待ち・取消・不正日付を除外し、重複IDは停止する。全件読込済みとは表示せず、続き／過去一覧の読込を案内する。実際のACKからの通し試験は未完了。
- **二重表示**：月別ACK時に募集を閉じる処理は存在するが、通常案件一覧からの履歴分離は未完了。履歴の非表示状態を実装・試験するまでは「原行を残しても二重表示しない」と認定しない。物理的なシート行の非表示・管理列更新は未実施。
- **取消**：受付は管理者への直接連絡のみ。既存の管理者取消APIを共通化して使用し、スタッフ向けの取消ボタンや自動再募集を追加しない。現在の取消行には担当IDが残り、既存Rulesでは担当本人から読めるため、UI非表示だけでは非公開履歴の要件を満たさない。非公開履歴へ移す設計は既存Source取消ACK・勤務日ロック・年間依頼集計の整合を保つ必要があり、Rules変更や実データ移行をこの指示の追加承認と扱わない。現行実績には取消件数はあるが、固定案件IDとスタッフIDで重複排除した年間依頼総数の受入は未完了。

### 検証の区別

PR239の最初のCI失敗は、認証検査の古い操作スキーマ、管理画面テストの旧2件前提、変更前workerソースハッシュの3件。検査を省略せず修正し、`685ed1` は正式CI3件が成功した。ただし後続変更はその成功を流用せず、最新コミットで再検証する。

ローカルの合成データ試験、正式CI、公開／配備、実業務での確認は別々に報告する。手入力の表示用フィクスチャに成功しても、入力経路・転記全体が完成した証拠にはしない。アプリ側との共有はこの文書、PR239、MASTERの案件58／82を使用し、別Dot本人の確認済みとは扱わない。7条件が揃うまでPR239をDraft／未マージに保つ。本番、原本、GAS、IAM、Rules、停止解除、実通知は変更しない。


2026-10-28 followup: current head8df5c43 CI40647710548 reached the browser suite and found an obsolete test expecting a newly applied pending job to be a second confirmed shift. The test now asserts one confirmed shift plus a separate pending section through refresh, then uses a test-only injected synthetic monthly-readback ACK before testing two confirmed cards. This hook is absent from production source. Pending applications are also excluded from the separately paginated past-history controller, and opening a pending application does not open confirmed-shift details. The calendar and browser correction require fresh CI on the new head; the failed run is retained as evidence, not rerun without changes. Local browser installation was unavailable because the browser download returned an invalid archive, so browser acceptance is delegated to the existing isolated canonical CI browser job.


### Followup under the same authorization

- The monthly calendar is loaded on demand when the shifts screen opens, with explicit loading/error/retry. Canonical head773cde0/run40648803592 failed the unchanged 350KiB entry limit (352.2KiB), before browser tests. The on-demand fix brings the entry to348.9KiB, with no threshold or workflow change. Head7a3ab70/run40649874506 then reached browser tests and found a second legacy scenario opening a pending application as confirmed; it now checks the separate pending section and uses the isolated test-only readback ACK before editing confirmed-shift inputs.
- Normal Admin filters exclude cancelled cases and only fully matching readback-verified CaseList transfers. Explicit histories retain both. This is an application view rule, not physical Source row hiding or cancellation access privacy.
- Admin-only performance now counts unique persisted caseID+staffID requests, including cancellations. Missing identity/date or conflicting duplicates give an unknown total, not0; same copied identity counts once. Existing cancellation APIs share a closed-recruitment patch, and cancellation restoration must remain stopped until separate explicit publication.
- Direct Source input is now observed privately with stable staff-ID resolution, Source revision/value proof and explicit blocked state. It creates no assignment, daylock, selection, queue, Source write or monthly write. This is preparation for the common engine, not completion of that input path. Exact remaining adapter contract is in `case-list-manual-origin.md`.
- Cancellation privacy remains unresolved under the unchanged Rules. The minimal proposed access restriction and effects are recorded separately; no Rules/IAM/cloud/GAS/native operations were performed.
