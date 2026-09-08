# 提出転送のローカル受入キット

本ツールは試験資料と合成テキストをローカルに作る。クラウドSDK・通信・書込・削除機能を持たず、事前検査が成功してもクラウド操作の承認を与えない。

新しい出力先を指定する。

```sh
node scripts/prepare-submission-acceptance-kit.mjs --output release-evidence/submission-acceptance-kit-new
node scripts/test-submission-acceptance-kit.mjs
```

出力はkit.jsonとfixture-1.txt/fixture-2.txt。存在する出力先への再実行は拒否し、上書きしない。8件の初期文書案にはexists=falseの条件を付け、12件の不存在確認パス、Storageの固定接頭辞、MD5/SHA256/バイト数、連番と書戻しキューの間接変更を含める。日付・会社・スタッフ・内容は合成データのみ。Firestoreへ送信できるRESTバッチではなく、データ/実行手順をレビューするためのJSONである。createdAt/updatedAt等の実行時Timestamp設定を含む投入処理は別途必要。

`evaluateSubmissionAcceptanceEvidence`は、キットと同じプロジェクト/指紋、10分以内の読取証跡、専用Driveフォルダの親/名称/実行アカウントの作成能力、Storage接頭辞の空状態、12パス不存在と6コレクションの会社別0件を確認する。欠落・不一致・重複パス・古い/未来時刻は失敗とする。証跡は呼出し側から渡すローカルデータであり、署名検証やクラウドからの取得はしない。手書きの成功証跡を実環境での検証と呼ばない。

初期生成では専用Drive IDが未確定なので必ず未準備となる。親共有ドライブのルートそのものを専用IDに指定することも拒否する。新規専用フォルダの実ID/権限確認・限定したデータ操作承認・レビュー済み投入手順がそろうまで実クラウド受入へ進まない。原本の同期、実スタッフへの通知、IAM/Rules変更は含まない。

確認範囲はfinalizeStagedUploadの順次2ファイル転送。ユーザーログイン、写真プレビュー、実並行イベント、応答喪失注入の受入ではない。サーバー側の既存一括検証はSUBMISSION_INTEGRITY_LOCAL.mdを参照。

## 転送後の読取結果をまとめて検査する

```sh
node scripts/verify-submission-acceptance-result.mjs --kit path/to/kit.json --result path/to/normalized-result.json
node scripts/test-submission-acceptance-result.mjs
```

このコマンドは2つのローカルJSONを読み、判定を標準出力へ返す。成功は終了コード0、不整合は1。クラウド接続・データ変更・片付け・自動再試行はしない。`--apply`は存在しない。入力を作るクラウド読取収集器も含めていない。

対象は専用の初期提出で、2ファイルを順次処理し終えた後の状態。Firebase TimestampはUTCのISO日時文字列、Firestoreフィールドは通常のJSON値へ正規化して渡す。転送元の世代・MD5・サイズはアップロード直後の記録から保持し、転送後の不存在読取と組み合わせる。削除後に元オブジェクトのメタデータを取得できると仮定しない。

| 入力の項目 | 必要な内容 |
|---|---|
| project / kitFingerprint | 対象projectと使用キットの指紋 |
| startedAt / readAt | 試験開始と読取完了のISO日時。読取は判定時刻から10分以内 |
| documents | `{path,data}`の一覧。初期8文書、fileCountersの1文書、生成されたsheetSyncQueueの1文書。IDを推測しない |
| drive.folders | 専用ルート、顧客、年月の3フォルダ。id/name/parents/mimeType/trashed |
| drive.files | 2ファイルのid/name/parents/mimeType/size/md5Checksum/appProperties/trashed/createdTime |
| storage | 2元オブジェクトのbucket/path/generation/size/contentType/md5Base64/exists。generationとsizeは文字列、exists=false |
| counts | notificationQueueとpushTokens、それぞれ`{companyId,count:0}` |
| listingsComplete | 専用範囲のページを最後まで列挙し終えた場合だけtrue。途中ページや予定件数で打切らない |

照合内容は、会社/案件/UID/担当/隔離設定の維持、親と2ファイルの完了、加算マーカー、連番1/2とcounter=2、転送計画・DriveのID/保存先/名前/内容/世代由来の指紋、転送元の不存在、完了日時の連動、キューが設定無効の理由でblockedになり再試行予定がないこと。2000年の合成案件のため、報告書表示は「遅延」を期待する。キューが別理由で止まった状態を正しい隔離の受入成功としない。

最初のファイル単体の転送では案件完了を記録せず、2ファイル目の転送時刻が提出全体と案件の初回/最新完了時刻になる。今回の順次初期提出専用の期待であり、既存提出・追加提出・再提出・並行処理へこの期待を流用しない。

`passed=true`は渡されたJSONの内部整合だけを表す。常に`actualCloudAcceptanceVerified=false`と`cloudExecutionAuthorized=false`を返す。証跡の真正性、実際の取得範囲、別会社データの非変更、原本への書込不存在はこのオフライン照合だけでは証明できない。合成成功データを実クラウド受入結果と呼ばない。失敗時はissueコードを調べ、無条件にイベントや転送を再実行しない。

2026-09-09のローカル検証は60ケース。重複Drive/連番、内容・世代・親の不一致、設定混入、親/案件の未完了、転送元残存、キュー誤停止/再試行、一覧欠落・重複・null、古い/未来日時、CLIの成功/失敗終了を確認した。既存の事前検査41ケースと独立した検証で、Functions配備は行っていない。
