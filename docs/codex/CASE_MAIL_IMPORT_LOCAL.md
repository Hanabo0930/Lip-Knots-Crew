# 募集対象の取得から登録までを管理画面で完結する

## 現在の推奨手順（2026-09-15）

1. 既存の案件メール保存状態から case-mail-source-export.mjs で出力するか、確認済み source.json から prepare-case-mail-targets.mjs で出力する。どちらも import-source.json / targets.json / review.json を生成する。
2. 管理画面の「アプリの照合データを取得」で import-source.json を選び、「現在の照合データを取得」を押す。
3. 対象を確認し「この内容で募集登録へ進む」を押す。照合結果のダウンロード、再変換コマンド、再アップロードは不要。
4. 募集登録画面でプレビューし、原本の確認記録IDと原本確認を入力して登録する。最新の受付設定・案件・担当・会社・操作権限は既存APIで再照合する。
5. 登録の応答を受け取れなかった場合は、表示された同じ登録の結果確認を使う。未確定の端末記録がある間は別の登録を始めない。

import-source.json は元募集の内容ハッシュ・取得時刻・最小の対象IDだけを保持し、件名・本文・宛先・氏名を含まない。ハッシュは原本の真正性や本人認証の代わりにはならず、原本確認を省略しない。生成される登録内容は従来CLIと同一で、送信は disabled のまま。

旧 targets.json は引き続き照合・保存に使用できる。元募集ハッシュのない旧ファイルから登録内容を推測して生成しない。以下の旧CLI手順も維持する。

検証: 外部の現行変換コードと合成入力による60条件、実画面から実サーバー処理を使うローカル統合（390/1280幅、応答喪失後の二重登録防止）、既存320/390/1280幅・認証切替・旧応答拒否が成功。CIでは外部フォルダーを必要としない test-admin-import-snapshot.mjs を通常検査へ追加。実環境の認証・外部の正式出力UI・応募返信/連絡結果接続・実受入は別途必要。

---
# 案件メールから募集取込JSONを生成するローカル受け渡し

このツールは読取済みの外部募集とアプリ側のスナップショットを照合し、管理画面へ渡すcampaign.jsonを生成する。実メール、元シフト、実Firestoreへ接続しない。生成成功は原本の真正性・管理者の確認・登録・配信の成功を意味しない。管理画面で現在値を読み直し、原本確認後に登録する。

## 実行

Hを正本としてCへ同じソースを反映し、Cの既存Node環境で実行する。次の4引数を1回ずつ指定する。出力先の親フォルダーは存在している必要があり、出力先そのものは新しい名前にする。

    node scripts/prepare-case-mail-import.mjs --source source.json --app app.json --external-code-dir 外部case-managementの場所 --out 新しい出力フォルダー

外部コードフォルダーには別タスクのcore.jsが必要。募集のvalidateDraft/canonicalだけを利用する。変換コードのSHA256を記録し、処理中に更新された場合は生成を中止する。渡すAPIにファイル/ネットワーク/環境変数/任意requireは含めない。外部コード自身の真正性を自動証明する仕組みではない。

成功時の出力はcampaign.jsonとreview.json。前者だけを管理画面の「募集データを取り込む」で選ぶ。後者には入力スナップショットと変換コードのハッシュ、取得時刻、募集操作/地域/枠数、登録が別途必要なことを記録する。件名・本文・メールアドレス・氏名・入力ファイルのパスを出力に含めない。既存出力を上書きせず、別タスクの外部コードフォルダー内にも書き込まない。

## 入力形式

各入力は8 MiB以下のJSON。これは今回定義した受け渡し用の包みであり、現在の別タスクが既に出力しているAPI応答ではない。APIの生の状態応答を丸ごと流用しない。特に認証トークンを含めない。外部側の出力UIとアプリ側の認証付きスナップショット取得は今後接続する。

source.jsonの最上位項目は、version=1、companyId、capturedAt、draft、rows、staffだけ。

- draft: 外部側の既存draftで生成・編集したPREVIEW案を丸ごと保持する。operationId、area、cases、addresses、snapshot、確認済みtemplate、subject、body等を手入力で再生成しない。1〜100枠。空本文/空白本文/改行入り件名/未確認書式は不可。
- rows: 外部側で読み取った現在の正規化済み案件配列。1万件まで。
- staff: 同じ読取時点の外部側配信先配列。1万件まで。これは配信先照合用であり、アプリの本人対応を氏名から推測しない。
- companyId: 明示した所属。アプリ側入力と一致させる。ファイルの申告だけで認証済みとは扱わない。
- capturedAt: 取得時刻をUTCのISO文字列で保持する。期限内に取得したことを自動保証する値ではない。

app.jsonの最上位項目は、version=1、companyId、capturedAt、policy、recordsだけ。

- policy: 現在のRecruitmentRoutingSchemaに従う受付設定。mail_bridgeを必要とする。
- records: 対象の対応記録を1〜100件。各要素はbinding、job、ownerの3項目だけ。
- binding: 現在のAutomationBindingSchemaに従う固定ID対応。
- job: idを明示した現在案件。companyId/caseId/dateKey/status/assignedStaffId/publishable等の募集可否フラグ、sheetRef.spreadsheetId、数値revisionを保持する。revision未採番の旧案件は既存サーバーと同じ0として扱う。任意の版文字列を別引数で渡さない。
- owner: 現在の固定ID所有記録。companyId/jobId/spreadsheetId/fixedCaseId/revisionをbindingと照合する。

元の募集の案件・宛先とsnapshotの内部一致を先に確認し、その後で現行の外部validateDraftを呼ぶ。これにより、snapshotだけを残してdraft.casesを差し替えたデータを通さない。原文本文の正規の編集は保持し、同じ操作キーに対する内容ハッシュの変更として扱う。

固定ID/所属/元表/案件/勤務日/所有版/現在の募集可否を既存prepareCaseMailCampaignで照合する。複数候補や欠けた対応を自動選択せず拒否する。通常と東北は別の募集操作を保持し、同じ送信操作を自動採番し直さない。案件メール側の日本時間・翌日以降という条件をそのまま適用する。

## 検証と残作業

test-case-mail-import-adapter.mjsに外部コードのフォルダーと新規証跡先を渡すと、合成データだけで現行の外部draft/validateDraft→生成JSON→管理画面の実パーサー→サーバープレビュー/登録→返信回収→既存応募確定を確認できる。実メール・原本への送信/保存はしない。

    node scripts/test-case-mail-import-adapter.mjs 外部case-managementの場所 新しい検証出力先

37条件の最終成功はC release-evidence/case-mail-import-20260914/tests-final/result.json。取得済みデータを受け渡し形式で用意する実導線、認証付きアプリスナップショット、実応募イベント、配備と実受入は未完。入力にcapturedAtがあっても現在値の自動取得済みとは表示しない。


## 認証付きでアプリの照合データを取得する（2026-09-14追加）

アプリ側の手作業によるapp.json作成を減らすため、次の3段階を接続した。

1. 元のsource.jsonと外部の現行core.jsから、対象ファイルを生成する。この段階ではapp.jsonは不要。
2. 管理画面の「アプリの照合データを取得」にtargets.jsonを入れる。管理者認証と現在の連携実行者を確認して、固定ID/勤務日から現在の案件対応を読み出す。表示を確認して照合データを保存する。
3. 保存したapp-import-….jsonと元のsource.jsonを既存の生成コマンドへ渡す。生成したcampaign.jsonを「募集データを取り込む」から原本確認後に登録する。

    node scripts/prepare-case-mail-targets.mjs --source source.json --external-code-dir 外部case-managementの場所 --out 新しい対象出力フォルダー

対象出力はtargets.jsonとreview.json。targets.jsonの項目はversion=1、kind=recruitment.import-targets、companyId、sourceOperationId、area、casesだけ。casesの各要素はfixedCaseId/workDate。本文・宛先・トークンは含めない。対象の生成時にも原文内部の一致と外部validateDraftを確認し、以前の同じ案の操作番号を保持する。

getCaseMailImportSnapshotは100枠までの固定ID/勤務日を受ける読取API。会社内の固定ID所有記録を2件まで検索し、対応がない場合や複数の元表に一致した場合は推測せず拒否する。唯一の所有記録も、保存先の文書ID・台帳の版・案件の勤務日・現在の募集可否と照合する。同じ取引で実行者/受付/全対象を読むため、読取中に新しい二重対応が生じた場合も検知する。書込みは行わない。

保存用スナップショットは既存app.json形式と一致し、トークン・実行者UID・本人情報・住所・メモ・不要な案件内容を含めない。画面の店舗表示名は確認用に別途返し、保存ファイルへは含めない。読取時刻を日本時間で表示し、これは取得時点の情報であることを明示する。入力変更・別の所属への切替では古い応答を失効させる。取得に失敗した場合は入力を保持し、以前の結果の保存操作は出さない。

この段階でも、別タスクが正式なsource.jsonを出力する導線は未接続。実SDK/索引/配備の受入は別であり、画面のデモと検証は合成データのみ。最上位の「入力を手で用意する」説明のうちapp.jsonは、この認証付き取得へ置き換えられる。source.jsonを生の/api/state応答から作ったと扱わない。

## 2026-09-15 新タスクでの出力接続と受入先の具体化

case-mail-source-export.mjsで外部LocalStoreの保存状態・募集案・名簿を再照合し、個人情報をコピーせずtargets/campaignとreviewだけを出力できるようにした。59条件成功。正式な募集案/名簿の出力導線・実返信/連絡結果は未接続。STAGINGの実一覧と7関数の固定世代ソース退避を確認し、専用Driveフォルダーを1件作成して既存受入キットへ実IDを反映した。Functions配備、Firestore/Storage投入、原本書込、実送信は未実施。詳細・制限・次の作業は[SOURCE_EXPORT_CONNECTION_20260915.md](SOURCE_EXPORT_CONNECTION_20260915.md)。継続予約automationを維持、旧9時期限は適用しない。
