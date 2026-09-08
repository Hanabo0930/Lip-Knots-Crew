# Drive転送の固定ID・再照合（2026-09-08）

PR124で残った「Drive成功後の応答喪失/DB保存失敗」「同じファイルの同時イベント」を対象とする。実モジュール全体を接続した30合成ケース成功。修正前は応答喪失・DB保存失敗・同時イベントで重複コピー、遅い失敗でcompleted→error、403で作成続行、異世代受付を再現。

転送前にgenerateIdsで発行した候補ID、連番、名前、保存先、元データ識別キーをFirestore transactionで保存する。競合時は保存済み計画を採用し、外部APIをtransaction内で実行しない。元識別キーはbucket/path/generation/size/MIME/MD5のSHA256。Storageはイベントの世代を明示して読み出し・後片付けする。

同じIDをfiles.getで照合し、404の場合だけcreate、409なら同じIDを再読取する。403・通信障害は未作成扱いせず停止。Drive応答のID、名前、親、MIME、サイズ、MD5、appProperties、ゴミ箱状態、作成日時が一致した場合だけ完了へ進む。提出日時はDrive作成日時を利用する。遅い失敗/開始処理が別実行の完了をerror/processingへ戻さない。

根拠: [Google公式: 事前発行IDと409](https://developers.google.com/workspace/drive/api/guides/create-file)、[公式: アップロード再試行](https://developers.google.com/workspace/drive/api/guides/manage-uploads)。Google Workspace形式への変換はこのID方式の対象外で、該当MIMEを拒否する。既存画像/PDFなどのバイナリ転送を対象とし、権限追加なし。

## 再現と証拠

固定依存がある環境で `node scripts/test-submission-lifecycle.mjs`。WindowsはLKC_TEST_DEPENDENCY_ROOTで既存固定依存を参照するか、H正本で `pwsh -File scripts/test-windows-local.ps1 -Task Prepare` を実行し、出力されたCキャッシュを使用する。Hが編集正本。

実uploads/drive-transfer/提出状態/再提出/履歴モジュール全文をコンパイルして使用。Firestore模擬を読取版番号による競合検出/transaction再試行へ拡張し、Promise待合せで2処理を重ねる。Driveは同じIDのcreateを409にし、作成済みだが応答を失う障害を模擬。実SDK transaction/Emulator/実Storage・Drive/メール・原本は使用しない。実並行サービス検証済みとは呼ばない。

30ケース: 既存提出一往復7、応答喪失/DB保存失敗/同時実行/遅い失敗/409不一致/403/世代違い7、Drive照合項目9、転送元不足5、予約DB失敗1、processing逆行抑止1。Firebase実型の数値generationを安全な文字列へ正規化し、安全整数でない数値を拒否。初回型ビルドの世代型差異を修正済み。

## 限界

同じ保存済みIDの再利用を合成API契約で検証した。実API応答・権限・世代保持・実DB競合は限定受入が必要。自動再配信/retry設定は変更しておらず、イベントが必ず再実行される保証は追加していない。既存ensureFolderの同時フォルダ作成は検査外で、保存先が予約計画と異なれば停止する。候補ID発行が重なっても採用されるID/連番は1つ。

PR124の転送済みcheckpointは従来どおり利用するが、新規計画の元世代/内容保証を旧データへ遡及しない。マーカーなし旧版Drive転送済みは自動再加算停止。MD5なし/不正イベントは転送前に停止。手動で計画やファイルを改変した場合の自動修復は行わない。原本/実DB変更の移行は作成・実行しない。

Functionsは今回未配備。将来の反映候補は既存許可対象finalizeStagedUploadだけ。反映前条件はSERVER_ROLLOUT_READINESS.md末尾参照。
