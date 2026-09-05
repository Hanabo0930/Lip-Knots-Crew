# 現在地・履歴・承認

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
| mainへのマージ | PRごとの明示承認後のみ。Head SHA固定・Merge commit |
| PR #94 | 上記Headに対して明示承認済み、既に完了。新PRへ流用しない |
| STAGING Hosting | 同一SHAのmain CIとPreviewを確認し、既定のPromoteを使用 |
| GitHub保護環境 | 必須の本人承認を維持。代行不能なら具体的な操作を一度に案内 |
| Production / Functions / Firestore / Storage / Rules / IAMの変更 | 個別の明示承認なしに実施しない |
| メール・通知の実送信、実ユーザーデータ操作 | フロントエンド検証のために勝手に実施しない |

ユーザーは手作業の削減を希望していますが、将来の全PRマージを許可する新しい文面は提案段階であり、承認済みとして扱いません。AGENTS.mdを変更して承認要件を緩める依頼もありません。

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
