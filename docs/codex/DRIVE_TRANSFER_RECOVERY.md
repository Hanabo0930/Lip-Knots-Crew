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

## 2026-09-15: 全体停止時の保存先不整合を修正（ローカルのみ）

停止分岐が旧collection submissionFiles/{fileId}へ書いており、現在のsubmissions/{submissionId}/files/{fileId}と親提出へ停止が反映されなかった。さらに親/ファイルが存在しないイベントや会社/本人の不一致でも旧collectionに記録を作れていた。

uploads.tsの既存停止分岐だけを修正。親と子をtransactionで読み、存在・所属・元Storageパス・完了数を照合してから、正規の子と未完の親へpaused_globalを原子的に反映する。完了済み/加算済みのファイルは変更せず、親にある別ファイルのエラーと完了を停止表示で上書きしない。転送計画・Drive ID・加算・エラーの証跡を消さず、停止中にDrive転送やStorage削除へ進まない。

実system-safety.tsを読み込む合成環境でAPP_ENVIRONMENTを切替え、全体停止分岐を検査した。これはVM内の環境であり、本番へ接続したものではない。追加12条件は修正前すべて失敗、修正後は既存314条件と合わせ326/326成功。停止→同じ提出の明示再処理、完了/一部完了/既存エラーの保持、親/子欠落、会社/本人/親所属/元パス不一致、同時完了の保護、片側DB書込失敗時の原子性を確認。Functions全体の型検査・ビルドも成功。C release-evidence/transfer-pause-20260915のbefore.log/after.log/build.logを保持する。

この修正は開発正本と通常C検証コピーだけ。PR142の公開Head408496c、追加検証候補8614cc0、独立C候補は変更していない。PR142の追加67テスト公開承認へ、この製品修正の公開を含めない。

残る制限:
- STAGINGは既存getProductionOperationalStateの対象外であり、この変更だけではSTAGINGを止められない。
- 開始済みの別実行を即時中断する仕組みや、停止イベントの自動再配信を追加していない。停止解除だけで提出が自動再開するとは扱わない。
- 実稼働版への反映、専用受入での実転送/応答喪失/再試行、互換復旧物、実行者自身のDriveアクセスは未確認。
- 旧版の非互換判定、旧加算不明の実記録1件への自動修復禁止を維持。P0は未完了。

## 2026-09-15 13:32: STAGING停止設定と専用受入の再処理経路（ローカル検証済み）

### 実装と適用範囲

- submission-transfer-control.tsでLKC_SUBMISSION_TRANSFER_MODEを判定する。未設定/activeは従来の本番稼働判定を維持し、それ以外は停止。非productionでも提出転送を止められる。会社単位の既存本番停止を上書きしない。
- 停止時は正規の親/子へ状態を記録し、子へbucket/path/generation/size/MIME/MD5をpausedTransferSourceとして原子的に保存する。既存計画と矛盾するイベント、停止後の異なる世代/内容を拒否。元ファイル・予約ID・完了数を保持する。
- createUploadSessionにも同じ設定を適用した。ただし現行の無人配備許可にこのCallableは含まれない。今回のfinalizeStagedUploadだけの配備で、新規提出セッションの受付も停止したとは報告しない。
- 環境変数は配備された実行版の設定であり、既に開始した処理を即時中断しない。停止版への100%切替、旧処理終了、既存記録の再分類を確認してから「停止済み」とする。
- retry設定は変更していない。停止解除だけでは受信済みイベントは再配信されない。[Firebase公式の再試行仕様](https://firebase.google.com/docs/functions/retries)を確認し、無条件の再試行による恒久エラー反復は追加していない。

### 保護付き配備での状態維持

staging-functions-deploy.ymlにtransfer_mode（preserve / active / paused）を追加。既定preserveは既存finalizeStagedUploadの設定を読み取って保持する。既存値が不正なら停止。明示active/pausedはFunctions指定がfinalizeStagedUploadだけの場合に限る。対象が別Functionsならpreserveのみ許可し、転送設定の読取・変更をしない。

設定は信頼側guardrailsのmaterialize-staging-transfer-mode.mjsが、通常生成されたSTAGING dotenvへ1キーだけ追加する。停止非対応のソース、重複キー、別環境、稼働版を確認できない場合は配備前に失敗する。許可Functions、IAM、保護環境、CI、配備元ガードは拡大・迂回しない。今回変更したワークフロー/ガードは通常PRで信頼側mainへ先に統合し、アプリ配備元の差分で保護ファイルを持ち込まない。

### 専用受入の再処理

scripts/replay-paused-submission.mjsは既存の専用受入キット2ファイルのうち指定した1件だけを対象にする。通常会社/通常提出は対象外。既定は読取だけで、一覧検索・Storageコピー・Firestore直接書込・認証代理は行わない。

事前照合:
1. lip-knots-crew-staging / asia-northeast1 / finalizeStagedUpload。確認済みrevision、ACTIVE、GEN_2、100%の最新revision、既存実行SA、staging環境、明示active、固定Storageイベント。
2. 読取transactionで親・2つの子・専用Drive設定を同時点確認。会社/本人/案件/担当/提出の一致、全ファイルの加算マーカーと親完了数、旧版加算不明・壊れた計画の排除。
3. 保存した元世代を指定してStorageのメタデータを読取り、キットの合成内容・MD5・サイズ・MIME・パスと照合。転送計画のsourceKeyも実コードと同じ構成で照合。
4. revision/元データ/各文書の更新版を含む指紋で計画を保存。実行時はその確認済みファイル、同じ指紋、5分以内の確認を必須にし、実体を再読取して変化があれば拒否。

実行は権限のある既存本人のID tokenで、実際のfinalizeStagedUploadへCloudEventを一度だけ送る。SA代理認証や権限追加をしない。CloudEvent形式は[Google公式例](https://cloud.google.com/blog/topics/developers-practitioners/how-to-develop-and-test-your-cloud-functions-locally)に合わせ、稼働版と100%切替の判定は[Functions v2 ServiceConfig](https://docs.cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions#ServiceConfig)に合わせた。

HTTP成功は呼出受付までで、提出完了/Drive実体一致を成功扱いにしない。タイムアウトやエラー応答は成否不明として自動再試行しない。Drive/DB/Storageの実体照合後に新しい計画を作る。実行証跡は新規ファイルだけに書き、既存証跡を上書きしない。実行中に別配備を開始しないことが運用上の前提。

CLI形式（実環境では今回未実行）:
- 読取: node scripts/replay-paused-submission.mjs --file 1 --revision <検証済みrevision> --output release-evidence/<新規確認ファイル>.json
- 実行: 上記と同じfile/revision、--review <確認ファイル> --execute <確認した指紋> --output release-evidence/<新規実行証跡>.json
- 認証は標準入力のJSON（accessToken、実行時のみidToken）。シェル引数・ログ・証跡へtokenを出さない。CLIオプションはユーザー承認の代わりではない。

### 実環境へ進める順序と残条件

通常PR/CIで今回の製品・復旧ツール・配備ガードをレビューし、対象SHAを確定する。公開済みPR142の127製品+67検証ファイルへの承認と、今回の追加変更の公開・統合・配備を混同しない。

追加範囲の必要承認後、CI成功の修正版finalizeStagedUploadをまずpausedで保護付きSTAGING配備し、revisionと設定、100%切替と旧処理終了を確認する。互換性のない旧版00005-pepへ戻さない。障害時は同じ検証済み修正版の停止モードを復旧候補にし、実配備物の取得/ハッシュ/再現を確認する。

専用会社へのキット作成・合成2ファイル転送・再処理には別途具体的なデータ操作範囲が必要。現在はキット未投入、実行者自身のDrive利用・実転送未確認。過去の空状態証拠は期限切れとして扱い、実行直前に再読取する。既存の通常提出4件、特に旧加算不明1件はこのツールで再処理しない。

### 検証結果

- 転送ライフサイクル344/344。停止→実ツールの計画/実行→実転送モジュール→通知/シート書込の無効化→結果検査まで接続。応答喪失後も2ファイルにつきコピー2・加算2を維持。実SDK/APIは模擬。
- 復旧モデル/HTTP/CLI49/49。確認後変更、親/子の加算不一致、旧記録、対象外、内容差、期限切れ、ID token不足、出力排他、応答不明を検査。
- 配備状態維持24条件、停止関数内部を確認する認証ガード6条件、既存Functions安全性検査、配備元ガード自己検査8条件が成功。
- Functions全体の型検査・ビルド成功。現行製品コードを検証後は変更していない。
- C release-evidence/staging-transfer-control-20260915に証跡を保存。CコピーではGit履歴不足で既存認証ガードが一度失敗し、Git正本で成功。製品回帰と区別する。
- クラウド配備/設定変更/実データ操作/実送信は未実施。P0-01を完了にしない。

## 2026-09-15 専用会社だけの受入と通常会社の停止維持

STAGINGで受入用の提出を動かすために active へ切り替えると、通常会社の新しいイベントも処理される。これを避けるため acceptance を追加した。APP_ENVIRONMENT=staging、EXPECTED_FIREBASE_PROJECT_ID=lip-knots-crew-staging、companyId=lkc-transfer-acceptance-20260908 がすべて一致する場合だけ転送を許可する。その他の会社・環境・不正なモードは停止し、既存のProduction緊急停止判定も維持する。

- 配備入力の既定値は preserve。acceptance の指定は finalizeStagedUpload 単独だけに限定し、既存の acceptance を preserve する場合も対応ソースが必須。
- 認証ガードと配備設定作成処理は、環境・プロジェクト・会社をANDで結ぶ実装を確認する。条件削除やORへの変更を拒否する。
- 専用再処理ツールは acceptance の実revisionだけを受け付ける。active、paused、制御未設定を拒否し、計画の指紋にもモードを含める。
- ローカル検証: 提出353条件、復旧50条件、配備設定38条件、認証ガード12条件、Functionsビルド成功。専用会社の処理前後に同じハンドラーへ通常会社のイベントを渡しても、通常会社はpaused_global・加算0を維持。専用会社は応答喪失後もコピー2・加算2。実クラウド操作は含まない。
- 初回統合検査の2件は、新規合成データに所属情報が不足していたテスト側の失敗。既存所属チェックを緩和せず、合成データを補完して全件成功。証跡はC release-evidence/acceptance-isolation-20260915。

### 実受入の限定手順（未実行）

対象は固定専用会社、専用Driveルート1UIrK62YaXUDtK8H2rvJcZV5nkej30vk0、既存受入キットの初期8文書と合成テキスト2ファイルだけ。通常提出4件と旧加算不明1件は再処理対象にしない。

1. 新候補を必須CIで検査し、保護された通常手順でmainへ統合する。FunctionsはfinalizeStagedUpload単独。通常会社を再開するactiveは使用しない。
2. 実行前10分以内に12文書パスの不存在・6コレクションの専用会社0件・専用Storage接頭辞の空を再確認する。DriveルートのID/親/名称、子要素、実行者の権限設定を通常の読取権限で照合する。
3. 既存の事前検査は、実行者自身のDrive作成能力が未確認なら不合格のまま保持する。代理認証を再試行したり、runtimeCanAddChildrenを推測でtrueにしたりしない。未確認の能力を実転送で調べる場合は、初回1ファイルを対象とする診断的な実書込を明示したデータ操作承認が別途必要。
4. 停止モードで初期8文書をexists=false付きの原子的createで作成する。通知設定・シート対応は無効、専用スタッフはactive=false。既存文書が1件でもあれば上書きせず停止する。
5. 固定Storageパスへ合成テキスト2件をifGenerationMatch=0で作成し、世代/サイズ/MD5を保存する。停止状態と元世代記録を確認する。曖昧な応答を理由にアップロードを繰り返さない。
6. finalizeStagedUploadをacceptanceで反映し、revision/100%トラフィック/環境/実行者を確認。旧revisionの最大実行時間を待ってから、専用再処理ツールの読取計画と指紋を確定する。
7. 第1ファイルを1回実行し、実Driveの固定ID/親/内容、Firestore加算1、元Storage世代の削除を照合する。失敗・応答不明時は停止し、同じ計画を盲目的に再実行しない。権限拒否ならIAMを変更せずpausedへ戻す。
8. 第1ファイルが成功した場合だけ、第2ファイルの新しい読取計画を作成して1回実行する。最終コピー2・加算2・元ファイル2件削除・専用会社の通知0を確認する。書戻しキューは設定無効のまま確認し、worker未反映/未実行ならblocked受入を完了扱いにしない。
9. 確認後または異常時はfinalizeStagedUpload単独をpausedへ戻し、その実状態を記録する。試験データや証跡は自動削除しない。現行互換版の配備物を退避し、旧00005-pepは復旧先にしない。

この手順だけで、実応答喪失注入・実クラウド復旧・実スタッフ受入を成功扱いにしない。新たな配備と専用データ操作の承認前に実行しない。実送信、実業務シフト原本変更、IAM/Rules変更、Production操作は対象外。
