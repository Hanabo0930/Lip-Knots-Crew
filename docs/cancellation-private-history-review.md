# 取消履歴の非公開化（承認済み・実装検証済み・検証環境への反映待ち）

2026-10-29、本人はこの具体案を対象にした確認へ「おけ、進めといて」と回答した。アクセス制限・索引1定義・既存取得条件・キャッシュと今後の通知文言を検証環境限定で進める承認として扱い、同じ承認を再要求しない。

実装は jobs Rules の本人 assigned 条件、既存本人クエリ5か所、索引1定義、キャッシュv2、直接取得・起動・更新・過去ページで拒否された案件/一覧/選択/関連taskの除去、取消通知2 APIの一般文言化。管理者向けの取消理由、案件ID/スタッフID、所有lockと年間依頼数の根拠は保持する。

ローカルの実Firestore Rulesエンジン82件、実Appの拒否/キャッシュ/5クエリ・過去ページ24件、読取監査25件、監査workflow境界12件、既存のStaff回復/過去年別18シナリオを確認した。実Rules・索引・アプリの配備と実データの読取監査は別工程であり、完了扱いにしない。Java21/Firestore1.21.0は配布SHA256を照合し、demoプロジェクトとlocalhost通信のみに隔離した。

配備前の jobs Rules は、担当スタッフIDが一致する取消済み文書も本人に読取を許可する。ソース上の制限と画面・応募APIの除外を確認しても、配備済みのアクセス非公開を満たしたとは判定しない。過去の取消理由通知も残り、一括削除や実送信は行わない。

## 提案する最小範囲

既存の管理者・会社境界・activeStaff・書込禁止を維持し、スタッフの jobs 読取を「募集中、または assigned かつ担当本人」に限定する。

```text
activeStaff() && (
  resource.data.status == 'open' ||
  (resource.data.status == 'assigned' && resource.data.assignedStaffId == staffId())
)
```

この案は status=cancelled を除外する。cancelled=true と status=open/assigned が矛盾する古い文書まで安全に扱えると決めつけない。全ての信頼済み取消書込元が status=cancelled と cancelled=true を同一トランザクションで設定することをコードで確認し、読取専用の監査で矛盾する現存文書がゼロと証明することを配備前提とする。監査拒否・不完全・矛盾発見時は停止する。データ補正や権限拡張の許可は本案に含めない。

Rules はフィルターではないため、同時に次を揃える必要がある。

| 対象 | 変更・影響 |
| --- | --- |
| apps/staff/src/App.tsx の本人シフト取得3か所 | assignedStaffId に加え status=assigned をクエリ条件へ追加。確認待ちも assigned のため取得できる。募集中クエリは既に status=open。 |
| apps/staff/src/past-shift-reader.ts の過去取得2か所 | 同じ status=assigned 条件を追加し、取消文書をページング対象から除外する。 |
| jobs COLLECTION 索引1定義 | companyId ASC / assignedStaffId ASC / status ASC / dateKey ASC。文書ID順は暗黙の ASC。既存定義との重複・利用する全クエリを隔離試験で確認する。 |
| apps/staff/src/business-cache.ts と直接取得経路 | キャッシュバージョンを更新し、旧12時間キャッシュを復元しない。permission-denied の案件は一覧・選択中詳細から除去し、古い成功状態を復元しない。 |
| 今後の取消通知 | 本人向け通知へ非公開理由を書かない。必要な一般文言と管理者への直接連絡を分離する。実送信・過去通知の一括削除は含まない。 |

担当スタッフID・案件ID・Source証跡は保持し、既存のSource取消ACK、勤務枠、年間依頼数、再取込の整合性を壊さない。getMyTasks 全面移行や公開文書の担当ID削除は変更範囲が大きいため、この案に追加しない。

## 承認された場合の検証と順序

対象は lip-knots-crew-staging のみ。実業務原本・本番・GAS・IAM・停止解除は対象外とする。

1. 正確な差分、既存Rules/索引/アプリ固定版の退避と復元手順を用意する。
2. 隔離エミュレータで、管理者履歴/年間数、本人/他人/別会社/未認証の取消読取拒否、通常募集/確認待ち/確定/月間/過去/ページング/キャッシュを通す。
3. 前記の取消状態の矛盾がゼロであることを読取のみで監査する。結果不明は成功としない。
4. 索引が READY → 新クエリとキャッシュ対応のアプリ → Rules の順に反映する。Rules を先に変えると旧クエリ全体が拒否されるため、旧アプリには更新が必要となる。
5. 固定版でアクセスと通常動線を照合する。想定外の拒否や露出があれば退避版へ戻す。実業務取消や通知送信で試験しない。

AGENTS.md に今回の狭い承認範囲を記録した。状態は **AUTHORIZED / SOURCE_IMPLEMENTED / LOCAL_TESTED / NOT_DEPLOYED**。IAM/GAS/本番/原本業務書込/停止解除/実送信/過去通知一括削除・データ補正は許可に追加しない。

## 配備前の読取監査

scripts/audit-staging-cancellation-privacy.mjs は既存のSTAGING固定read transportを使い、全 jobs の status/cancelled の2項目だけを読取専用トランザクションで取得する。会社で絞ると他社文書の矛盾を見落とすため、同じ検証プロジェクトの全件を対象にする。上限+1、不完全応答、重複、別project、不明状態/型、読取時刻不一致、rollback失敗では証明しない。status=cancelled と cancelled=true の不一致が1件でもあれば HOLD。記録は集計数・日時・完了フラグのみで、文書ID・スタッフ情報・理由・トークンは保存しない。PASSでも deploymentReady=false とし、配備物の来歴や退避の別要件を省略しない。

監査は既存 .github/workflows/staging-functions-deploy.yml の `cancellation-privacy-audit` モードで行う。source_ref=main / functions=none / transfer_mode=preserve / 確認語 AUDIT_LKC_STAGING_CANCELLATION_PRIVACY を必須にし、deploy/Gmail smokeのjobは実行しない。同じ監査スクリプト1本を呼び、通常の対象選択/月別writerは増設しない。現在mainの正式CI成功、既存の保護環境とobserver identityを要求し、保護レビュー後にmainを再照合する。Rules/索引/業務文書の変更機能を持たせない。

独立した旧監査入口はPR240で通常統合し、main dd053e1の正式CI全3成功後に実行40793656805を1回だけ起動した。guardと保護レビューは通ったが、Google Cloud federation attribute conditionで認証拒否となり、データ読取はSKIPPED・INCOMPLETE・成果物0。2026-10-29の本人の停止解決指示に基づき、PR241で実行入口を既存の信頼済みworkflowへ通常CI/mergeで統合し、独立入口を削除した。WIF/IAM/資格情報/保護設定を変更せず、元の失敗runの再試行やworkflow_ref偽装はしない。PR239を未完成のまま先に統合して監査する循環も避ける。統合後のmain正式CI・保護付き実監査は別に確認し、成功を先取りしない。

## 配備物の退避と復元

- 実行直前のFirestore Rules release/rulesetの固定名・全ソースSHA、該当jobs索引の全定義とREADY状態、既存Staff/Admin Hosting固定版を退避し、読み直して一致を確認する。
- 索引は承認した1定義だけを対象にし、既存索引全体のデプロイや削除を行わない。READY未確認ならアプリへ進まない。
- 対応アプリを既存の保護付きHosting手順で反映・検証してからRulesを反映する。Rules変更前に再度main/配備版/退避/監査/会社境界とwriterの状態整合を照合する。
- 問題があれば退避したRulesを先に戻し、固定Hosting版を復元する。追加索引は安全な未使用状態で保持し、他索引の削除や業務文書の補正で復旧したことにしない。
- 現実の配備済みwriterの来歴・権限や現存状態を証明できない場合は反映しない。ローカルまたは正式CIの成功で実環境の証明を代用しない。

別途、案件リストSourceのネイティブ取消ライターは未追加である。Source読戻しACKの検証は、ネイティブ取消書込が実行済みという証明にはならない。未選択手入力の条件付きロック解放と、選択済み・結果不明の保持を混同しない。
