# 提出・管理者確認・再提出のローカル結合検証

2026-09-08。ログイン後の合成claimsを入口とし、createUploadSession → finalizeStagedUpload → markSubmissionCompleted → createResubmissionRequest → 再提出 → getResubmissionComparison / getSubmissionTimeline → completeResubmissionRequest の実モジュール全体を同じインメモリDBへ接続する。

## 再現と保証範囲

固定依存がある環境で `node scripts/test-submission-lifecycle.mjs`。WindowsはH正本の `pwsh -File scripts/test-windows-local.ps1 -Task Prepare` が出力するCキャッシュで実行するか、LKC_TEST_DEPENDENCY_ROOTで既存固定依存を参照する。CからHへソースは戻さない。

業務モジュールは全文をコンパイルして使用する。SDKのCallable/Storageイベント登録、Storageデータ、Drive API、Firestoreを合成境界へ差し替え、許可外importは拒否する。実utils、通知・提出状態・履歴・再提出のロジックを使用。Firestore境界は読取先行、原子的commit、入れ子のupdate/merge、arrayUnion、query、失敗注入を模擬する。実データ・メール・原本・GAS・ネットワークは使用しない。

Java/Emulatorキャッシュが見つからないためEmulator未使用。Auth署名検証・メールログイン・ブラウザ下書き/転送・実並列transaction・実Drive/Storage・実通知/書戻しは対象外。ログイン済みclaimsの権限検査を、実ログイン受入とは呼ばない。

## 検証シナリオ

1. 報告書提出→完了→管理者の画像単位再提出依頼→早すぎる完了拒否→再提出→新旧比較→管理者完了。元Driveファイルと提出履歴を保持。完了後のイベント再実行でも再提出状態とreplacementFiles件数が変わらない。
2. 2ファイル提出の1つ目を2回処理してもcompletedFiles=1、案件完了/書戻しキューなし。2つ目の再実行でもcompletedFiles=2、Driveファイル2つ、案件完了キュー1件。
3. Storage後片付け失敗でも提出状態completedを保持。イベント再実行で同じ転送結果を利用し、再加算・再コピーしない。
4. Driveコピー結果保存後、案件完了のDB処理で失敗。再実行で保存済みファイルを使用し、完了数と書戻しキューを重複させずエラー表示を解消。
5. 売場画像の完了は報告書に影響しない。他スタッフは提出/状態取得を拒否。
6. 1ファイルの転送失敗を別ファイル成功で消さない。失敗分の再試行成功で全件完了。
7. 旧版の転送済みファイルで加算済みか不明な場合は、Driveコピー・DB変更前に停止する。

修正前は二重加算、後片付け失敗時のcompleted→error、DB再試行時の再コピーを再現。通常の再提出一往復と種別/他人分離は修正前から成功。

## 実装と限界

uploads.tsでtransferCompletedAt/Drive IDを保存し、保存後の再実行では同じファイル・連番・提出時刻を使う。completionCountedをファイルと提出件数のtransactionに含める。submission-status.tsのjobStatusAppliedを、案件完了と書戻しキュー作成のtransactionに含める。後片付け削除は業務処理のcatch外で行う。

**Drive成功からDBチェックポイント保存までの応答喪失、チェックポイント未保存の同時イベントは重複コピーを防げない。** この窓を閉じるには外部転送側の安定ID/再照合と別途検証が必要。SDK transactionの再試行・同時実行は今回のメモリ境界では保証しない。旧版の転送済みで新しいマーカーがないデータは自動修復せずfailed-precondition。旧データ移行・再投入は未実施。

7シナリオは再実行時の永続チェックポイントを検証するもので、exactly-once配信の証明ではない。Functions反映や実業務受入をHosting反映で代用しない。取消後の提出受付方針は変更しない。

検証結果: 7合成シナリオとFunctions全体型ビルド成功。既存認証ガードはGit履歴のないCキャッシュでは実行不能だったため、コミット後のH正本で対象Functionと正確なHeadを指定して確認する。
