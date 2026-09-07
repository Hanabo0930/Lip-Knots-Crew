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