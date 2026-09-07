# 勤務枠の読取専用診断

このツールはローカルJSONを照合するだけです。Firestore・Google Sheets・GASへ接続せず、修復・通知・同期を実行しません。原本変更禁止は維持します。

## 入力と実行
入力は会社1社分のjobs/locks配列です。jobsはid/companyId/status/cancelled/assignedStaffId/dateKey、locksはid/companyId/jobId/staffId/dateKey/activeを含めます。余分な氏名・メール・金額などは出力へ転記しません。出力には文書IDが残るため、公開資料として配布しないでください。

complete.jobs/complete.locksは、その会社の対象を欠落なく含む場合だけtrueにします。取得途中や日付範囲限定で対応相手が含まれない可能性がある場合はfalseまたは省略します。スナップショット同士の取得時刻差も確認してください。診断は保存された状態の照合であり、現在の稼働状態や過去の発生原因を保証しません。

```powershell
node scripts/diagnose-shift-integrity.mjs --input config-samples/shift-integrity.synthetic.json --output release-evidence/shift-integrity-example.json
```

終了コード: 0=範囲内整合、2=要確認の不整合、3=取得不足で未確認、1=入力/出力エラー。2/3でもJSONレポートは生成されます。入力や既存出力は上書きしません。標準出力は件数・状態のみです。実データの取得やエクスポートはこのコマンドに含まれません。

## 問題ごとの確認

| コード | 意味 | 次の確認 |
|---|---|---|
| INVALID_ASSIGNMENT | 担当者または日付が不正 | 元案件の正しい担当者・日付を確認 |
| MISSING_LOCK / INACTIVE_ASSIGNED_LOCK | 有効な担当案件に対応する勤務枠がない/無効 | 同日別案件の手配と応募記録を先に照合 |
| LOCK_OWNER_MISMATCH | 枠が別案件を参照 | どちらが有効な手配か確認。機械的に解除しない |
| DUPLICATE_ASSIGNMENT | 同じ担当者・日に複数の有効案件 | 実業務の手配を確認し、正しい案件を決める |
| INVALID_LOCK_METADATA / AMBIGUOUS_LOCK_STATE | 枠ID・所属・状態が不明/不一致 | 保存履歴と元案件を確認。旧データを推定修復しない |
| ORPHAN_ACTIVE_LOCK | 取得済み全案件に所有案件がない | 案件の削除/移動履歴と取得条件を確認 |
| ACTIVE_LOCK_FOR_INACTIVE_JOB | 取消/未手配案件の枠が有効 | 取消履歴と同日の新しい手配を照合 |
| LOCK_ASSIGNMENT_MISMATCH | 枠と案件の担当者/日付が異なる | 日付変更・担当者変更の履歴を照合 |
| LOCK_NOT_IN_SNAPSHOT / JOB_NOT_IN_SNAPSHOT | 取得範囲が足りず相手を照合できない | 対応相手を読取り、範囲を明示して再診断 |

診断結果だけで原本やDBを変更しません。修復する場合は、対象ID・現在値・修正候補・根拠・退避方法を確定し、承認範囲を確認して別工程で実施します。複数の指摘が同じ案件に重なる場合があり、指摘件数は不具合案件数とは異なります。

## 取込リースの改善
最大実行時間540秒に対し旧リースは480秒だったため、取得成功時から600秒へ変更しました。取得transactionが再試行された時は、その時点で期限を計算し直します。
25案件の更新単位ごとに同transactionでリースを読取り、会社・token・期限を照合します。取得結果なし/期限切れ/所有者交代ではその単位をabortedで止めます。先に正常完了した単位は残ります。終了時は自分のtokenである場合だけ解放し、後続所有者のリースは削除しません。
更新単位あたり最大読取が75→76件に増えます（再試行時は増加）。通常解放が行われなかった場合の待ち時間は最大10分です。実Firestore負荷・実回線速度・実データは未検証。Functions反映時は手動取込と定期取込の同版整合が必要ですが、本作業ではどちらもデプロイしていません。

## 未完了の業務判断
取消後の精算・写真の新規受付、取消済案件への再手配、原本の専用取消列、GASへの伝播は別途確認が必要です。通常の継続指示を原本変更やFunctions対象拡張の許可とは扱いません。
## STAGINGからの取得（2026-09-07追加）
`scripts/read-staging-shift-integrity.mjs`は、接続先をlip-knots-crew-stagingの(default)へ固定し、指定したcompanyIdのjobs/staffDayLocksだけを読取専用transactionで取得します。Google SheetsやGASへのアクセス、書込、同期、通知、権限変更はありません。

両コレクションは同じtransactionを使います。取得するのは本ガイド冒頭の照合項目だけです。各コレクションの上限は10000件で、10001件目が見つかれば部分データを診断せず失敗します。取得エラー・不正応答・会社混在・重複ID・終了処理失敗でも正常レポートを出しません。会社条件に一致しない文書（companyId欠落を含む）は範囲外です。両方0件の場合も会社設定や投入状況が未確認なのでunverifiedとします。

CLIは`--company <companyId> --output <新規ファイル>`を受け取り、既存認証の短期アクセストークンを標準入力からのみ受け取ります。トークンを引数・ソース・ファイル・ログへ保存しないでください。既存出力は上書きしません。取得失敗時は予約済みの空ファイルが残る場合がありますが、それは診断結果ではありません。認証や権限が不足した時に自動ログイン・権限追加・別環境への切替はしません。

標準出力は状態・件数のみ。保存するのも生スナップショットではなく診断レポートで、指摘対象のIDが含まれるためrelease-evidenceなどGit除外済みの非公開場所で管理します。APIの読取課金と取得時間は発生し得ます。取得は自動スケジュール化していません。

根拠: [beginTransaction](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/beginTransaction)のreadOnly指定、[runQuery](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/runQuery)の既存transaction指定。トランザクションの終了はrollbackのみでcommitは使いません。

2026-09-07のSTAGING読取確認: 設定サンプルで使用されるcompanyId=lipknotsについてjobs=0、staffDayLocks=0。結果unverified。これは指定会社の2コレクションの結果であり、他社・別コレクション・原本の空判定ではありません。実業務データに対する診断受入は未完了です。証跡release-evidence/staging-integrity-read-20260907.json。

## 管理者の再手配で止まった場合
変更先の勤務枠が存在する場合、会社・担当者・日付・activeの真偽値が一致している必要があります。不整合な無効枠も自動的に上書きしません。同日の別案件が有効な枠を所有する場合は、その案件の手配を先に確認します。案件日付が不正な場合も新しい手配は保存しません。

これらの検査で拒否されたtransactionは、案件や旧枠も変更しません。既存診断のINVALID_LOCK_METADATA/AMBIGUOUS_LOCK_STATE/LOCK_OWNER_MISMATCHなどを手掛かりに読み取って照合し、機械的な枠解除で回避しないでください。通常編集には追加読取なし。これはソース修正であり、Functions反映前は稼働環境の振る舞いに変化しません。
