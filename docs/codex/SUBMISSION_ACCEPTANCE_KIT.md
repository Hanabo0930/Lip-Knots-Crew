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
