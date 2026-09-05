# 現在地・履歴・承認

## STAGINGのシフト参照元確認（2026-09-05）

STAGING FirestoreのsheetImportConfigsを設定項目だけ読み取り、1件・enabled=true・scheduleEnabled=false・spreadsheetId設定ありを確認。最新sheetImportRunsはmode=commit/status=completed、2026-07-17T23:48:19.670Z完了（日本時間7月18日8:48）。シート名称メタデータは403で取得不能。テスト専用表か業務用表かは未確定で、デモ画像をそのシートから撮ったとは扱わない。シート本文・個人情報・シートIDは出力せず、権限変更・再取込・データ書込は行っていない。証跡はrelease-evidence/staging-sheet-source-check.jsonとstaging-sheet-last-run.json。


## 最新の承認と公開状況（2026-09-05）

ユーザーがSTAGINGも自動実行するよう追加承認。対象は既定のStaff/Admin Hostingの検証・正規の保護環境承認・反映・復旧・後片付け。Functions・実メール・実データ・Rules・IAM・Productionの承認範囲は拡大しない。以前のSTAGING本人操作必須の記述はこの更新で置き換える。

通常の開発PRは都度承認なしでマージまで進める。詳細は下記の承認表とAGENTS.mdを参照。以下の過去記録にあるPRごとの承認要件より、この最新承認を優先する。

PR #95は承認Head 5a75a1990b38b0c0666b56fe3410fe5de1795fddをMerge commit c57f200e6185a91fde8fe3a770fe248981c22432で取り込み済み。PR CI全3ジョブ成功。main CIとSTAGINGはGitHubの同一SHAの実行結果で確認する。


## Hドライブへの集約とAdmin改善（最新・2026-09-05）

ユーザーの明示指示により、開発の正本は `H:/マイドライブ/アプリ開発/Lip-Knots-Crew-Codex/Lip-Knots-Crew-git` に統一。下記の「Cドライブを開発checkoutとする」という過去の案内は撤回する。

- 最新ソース・Git履歴・引継ぎ・前回と今回の画像証跡・依存一式はH内に保存。入口は親フォルダの `CODEX_START_HERE.md`。
- `release-evidence/environment` に固定依存のアーカイブとlockfile照合情報を保存。Drive上での大量ファイル展開を避け、`scripts/test-windows-local.ps1` がHのソースから一時検証キャッシュを生成する。編集・commit・pushはHで行い、キャッシュからソースを戻さない。
- `release-evidence/batch49` に検証ログ、変更前後の測定JSON、画面PNG、ビルド成果物を保存。旧Cフォルダを開く必要はない。元の配布版とZIPは削除していない。
- Adminの20パネルを5業務へ整理。入力保持、案件→経費の導線、運用情報11件の必要時読込、認証変更後の応答破棄・取得データ消去、部分失敗からの再試行を追加。全体停止判定の取得は起動時に残した。
- ローカル型・ビルド・起動・容量・Staff回帰・Staff/Adminブラウザ検査成功。最新PR CIはPR #95を確認。この記録時点では今回分をまだpushしていない。
- mainマージ・デプロイ・クラウドデータ変更は未実施。以前のPR #94承認をPR #95へ流用しない。


## 2026-09-05 Codex再開後の更新（以下の旧スナップショットより優先）

- PR [#95](https://github.com/Hanabo0930/Lip-Knots-Crew/pull/95) はDraft・未マージ。再開時Headは `cb980b6b3b833e3a9c4622bd68dd3973c09640b7`、mainは従来の `94e9fb9c73f8be47c30da2c0335f853cfd0bd2b4`。既存PR CIの3ジョブ成功を再確認。
- Hドライブの配布版にはGit履歴がない。取得ブランチとアプリ・scripts・docsの内容を照合して一致。実装は同じBatch 48ブランチへ継続し、別のDraft PRは重複作成しない。
- 前回未完了だったブラウザ検査は完走。fixtureがSPAのホームへ置き換わる検査コードの問題を修正。
- 続けてホームの業務情報優先、狭幅の提出履歴と再取得操作、転送失敗後の未開始分停止、会社・ユーザー別の下書き保存を実装。Staff回帰検査とブラウザ検査をPR/main CIへ追加。
- Node 22.23.1でStaff/Adminビルド、容量、起動、会社分離、Staff UX、提出回復、デモ、安全検査成功。ブラウザは320/390/1280px、ルート文字32px、キーボード再取得、実IndexedDB分離を確認。デモ以外の送信なし。
- 最新のPR HeadとCIはPRで確認する。この追記時点では変更後CIをまだ実行していない。main承認・デプロイは実施していない。
- 所有者不明の旧形式下書きは自動移行・復元しない。データは削除しないが、利用者は元ファイルを再選択する必要がある。

ローカル環境の注意: Hドライブでnpm展開時にUNKNOWN/EBADFが多発。Cドライブの独立checkoutでは22秒で依存導入成功。開発checkoutは `C:/Users/lipkn/Projects/Lip-Knots-Crew-Codex`。Hドライブの配布版は旧スナップショットとして維持。同一ブランチを両方で同時編集しない。


2026-09-05に取得した状態です。再開時はGitHubの実状態を再確認します。

## 確認済みの公開状態

| 項目 | 確認結果 |
| --- | --- |
| リポジトリ | `Hanabo0930/Lip-Knots-Crew` |
| main | `94e9fb9c73f8be47c30da2c0335f853cfd0bd2b4` |
| 直前の完了Batch | Batch 47: Staff端末操作をログインセッションごとに分離 |
| PR | [#94](https://github.com/Hanabo0930/Lip-Knots-Crew/pull/94)、Merge commit済み |
| 承認済みPR Head | `626cf2ac14f7c5cc8c44b58c321d1d964b198576` |
| PR CI | [run 33940536786](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/33940536786)、成功 |
| main CI | [run 33940856894](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/33940856894)、成功 |
| STAGING Preview | [run 33940915054](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/33940915054)、同一main SHAで成功 |
| STAGING Promote | [#86 / run 33940990141](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/33940990141)、同一main SHAで成功 |
| Staff確認先 | [STAGING Staff](https://lip-knots-crew-staging.web.app) |

Promoteログでは反映前Staff 259ms / Admin 214ms、反映後Staff 527ms / Admin 456ms、HTTP 200、ブラウザ検査の問題0件。これはワークフローの限定的な画面検査であり、実スタッフの業務完了やメール到達を証明するものではありません。

ロールバックは不要でスキップ。`rc-94e9fb9c73f8` と `rb-33940990141` の一時チャンネルを両サイトから削除済みです。削除済みPreview URLを確認先として再利用しないでください。証跡artifact digest: `b4d0b754abf36e33d9eba727cedccb436f516d4ecaaa5fa9338b501f2f4df9ff`。

## 現在のBatch 48

ブランチ: `automation/codex-workspace-submissions-batch48-20260905`

目的は、開発情報の集約と、提出依頼から画像確認までの操作の修正です。

- 再提出タスクの `metadata.type` を使い、売場画像と報告書を正しく開く。
- 不完全な依頼から誤った提出画面を開かない。
- URLが未取得の画像にも再読込ボタンを表示する。
- 画像再取得の同時実行を抑え、対象ファイルやセッション変更後の古い応答を反映しない。
- 固定日付で過去扱いになっていたデモのシフトを翌日にする。
- このフォルダにCodex用の入口、要件、監査結果、検証手順を置く。

この文書の作成時点ではBatch 48はmain未マージ・未デプロイです。PR番号と最新CI状態はブランチに対応するGitHub PRで確認してください。文書へ未来の成功を先書きしません。

## 引き継ぐ承認範囲

| 操作 | 現在の扱い |
| --- | --- |
| ソース・既存仕様の監査、実装、ローカル検証 | 最新の開発継続依頼に基づき自律実行 |
| 専用ブランチへのアップロード、Draft PR、PR CI追跡 | 依頼範囲内で自律実行。通常の都度確認は不要 |
| mainへのマージ | 通常の開発PRは包括承認済み（2026-09-05）。必須CI成功の現Head SHAを固定し、Ready化・Merge commitを自律実行 |
| PR #94 | 上記Headに対して明示承認済み、既に完了。新PRへ流用しない |
| STAGING Hosting | 包括承認済み（2026-09-05）。最新mainと同一SHAのCI・Preview・Promote guard成功を確認し、既定のPromoteから反映・事後検証・後片付けまで自律実行 |
| GitHub保護環境 | lkc-staging-hostingのみ、既存接続権限で正規のpending-deployments承認APIを自律実行可能。保護設定を変更・迂回しない。権限不足の場合のみ本人操作を案内 |
| Production / Functions / Firestore / Storage / Rules / IAMの変更 | 個別の明示承認なしに実施しない |
| メール・通知の実送信、実ユーザーデータ操作 | フロントエンド検証のために勝手に実施しない |

2026-09-05、ユーザーが「マージの承認も不要」「承認規則も合わせて変更」と明示。通常開発PRの都度承認を撤廃した。既存のProduction・実送信・実データ・対象外クラウド操作の個別承認と保護環境は維持する。本人の判断が必要なときだけ番号付きの選択肢を示し、承認済み作業は停止せず進める。

## 会話の継続情報

- Batch 29〜31: Staff操作の同時実行と提出下書きの競合対策。Batch 31完了後にHosting起動自動化へ移行。
- Batch 32: Preview成功からPromoteを起動する仕組み。保護環境承認、バックアップ、ロールバックを維持。
- Batch 33〜46: 下書き・非同期処理・操作性の改善を継続。各Batchの正確な差分はGitHub PR #78〜#93と履歴を確認する。会話にない詳細は補完しない。
- Batch 42: Hosting Promoteと安全検査を変更。古い待機実行の扱いを見直した履歴がある。最新workflowを正とする。
- Batch 47: PR #94、端末一覧・登録・失効操作のセッション分離。今回成功を確認。
- Staffコード未着の相談とAdmin Previewの「サイトが見つかりません」があった。現在は管理者とStaffのログイン方法の案内を分離し、削除されたPreviewを案内しない。これだけでメール未着の全原因が解消したとはしない。
- 今回の依頼: 一つのフォルダでCodexへ引き継ぎ、要件から見直し、エラー・速度・デザイン・必要機能をまとまった単位で改善する。

## ユーザーへの応答

標準語の日本語。呼称は社長、ケイとして温かく簡潔に応答し、希望に応じて❤・💋を添える。細かい定型報告を大量に出さない。本人の操作が必要な段階では「社長がやること」を先頭に、リンク・対象・入力値をまとめる。Admin Previewへのログイン確認を求めない。

AGENTS.mdの完了報告項目は簡潔に記載し、必要なら折りたたみにまとめる。失敗・未検証を成功扱いしない。

## ファイル選択の復旧（2026-09-05）

再提出で不適切な形式・50MiB超・取消を選ぶと、既存の正常なファイルまで消える問題を修正。無変更の追加（重複・件数上限）でも既存ファイル・確認・転送表示を保持し、有効な変更時だけ確認を解除する。画像確認にはブラウザ標準のlazy読込とasyncデコードを指定し、原本・送信サイズは変更しない。実機での速度向上率は未計測。

実ハンドラーで取消、形式、50MiB境界、重複、20件上限、混在、差替、操作ロックを検査。実ブラウザで画像デコード・無効差替の保持・取消・PDFへの差替・確認解除・削除を確認。Staff型ビルド、UX127項目＋5シナリオ、320/390/1280px・文字拡大・既存提出復旧のブラウザ検査成功。検査セレクター誤記は修正して再実行成功。実送信・実データ操作なし。この記録時点ではPR/マージ/STAGING反映は未実行。
