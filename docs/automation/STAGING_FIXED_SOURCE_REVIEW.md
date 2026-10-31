# STAGINGの固定世代コード照合：追加範囲のレビュー案

2026-10-30。追加範囲の提案と、未接続のオフライン実装を記録する。実際の固定ソース取得、公開判定経路の変更、Hosting/GAS/Functions/IAMの変更はまだ実施していない。

## オフラインで準備した実装

- 既存`collect-upload-metadata.mjs`へ未接続の`collectFixedUploadSources`を追加。既存の読取診断CLIとworkflowからは呼ばれず、live transportの暗黙選択も行わない。公式Function・Buildの既存validatorを再利用し、固定の2object、最大12 GET、各10 MiB/合計20 MiB、STANDARD、世代・実バイト数・CRC32C/存在するMD5とBuild hash、取得前後の不変性を確認する。失敗時はstreamを取消し、追加通信を行わない。Requester Paysの有無をobject metadataから推測せず、`userProject`や課金headerを送らず、条件要求は停止する。
- ZIP本文は非列挙のprivate captureだけに保持する。通常のJSON・console表示用に返すdiagnosticsは`deployedSourceVerified:false / hostingPromotionAuthorized:false`。callerの`verified`、取得後の自己計算digestや`COLLECTED`を公開許可へ変換しない。
- 既存readiness validatorへ`strict=True`を追加。従来の保存資料経路は既定動作を維持する。厳格経路では完全inventory以外の秘密・未知ファイル、不正ZIP構造や特殊entryを拒否する。未索引の前後・隙間・圧縮後余剰bytesを拒否し、コメント・extra・Zip64を含まない保守的なclassic ZIPだけを受け付ける。この形式条件に合わない実資料も停止扱い。実ビルドが生成する`lib/**/*.js.map`も厳格inventoryへ含めて内容を照合する。
- 合成ZIPの取得から厳格inventory照合までを接続した隔離試験、各GET段階の401/403/429/500、サイズ・世代・checksum・配備変化・期限・本文取消の試験を、既存の正式CI対象テストから実行する。合成試験であり、実配備ソースとの一致を確認した結果ではない。

同一protected runへの真正なacceptance receipt結合、runner上の一回制御、POST直前の再照合、workflow入力・認証への接続はまだ実装していない。実取得とその費用の限定承認後に仕上げる。保存経路の独立pin、`VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED`、現行公開guardを緩める変更はない。

## 確認済みの停止原因

- 旧公開#411は本人承認後に取消済み。#496の保護レビューも本人承認後に完了し、承認待ちは解消した。
- [公開#496](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/41017053194)は、Cloud認証より前に`VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED`で停止。独立審査済みのsource evidence pinは未設定で、固定ソース資料の配送手順もない。315 bytesの保存結果は`externalApiInvoked:false / deployedSourceVerified:false`。画面反映・GAS反映はない。
- [読取診断#501](https://github.com/Hanabo0930/Lip-Knots-Crew/actions/runs/41036333470)は、現在main `5e69ff29ce62e234c065a9016a21cde25e3b0367`、`readiness / metadata_only=true / source-provenance`で成功。Function GET 2件と参照Build GET 1件は200。2APIの配備情報は10/28の保存結果と同じで、更新日は9/20。参照Buildの`sourceProvenance`は空、`fileHashes`がない。source archiveは未取得、Hostingの反映許可判定はfalseのまま。
- 既存の`STAGING_SOURCE_EVIDENCE.md`は、公式BuildのSHA256と独立審査済みpinを要求する。この実記録から適格なbundleを作ったと扱うことはできない。手元で計算したSHAだけをpinにしても真正性の証明にはならない。
- Googleの仕様上、Buildの`fileHashes`は`BuildOptions.sourceProvenanceHash`が要求された場合にだけ設定される。欠落をCLIの再試行で補えるとは判断しない。

## 推奨する追加範囲

取得済み資料を使う現行経路は維持し、明示承認された実行だけに、Googleの認証済みAPIから固定世代をその場で取得する照合経路を追加する案。既存`collect-upload-metadata.mjs`、`hosting_source_evidence.py`、`check-hosting-api-readiness.py`、保護付き`staging-hosting-promote.yml`の担当範囲へ接続する。同じ公開処理や別の月別writerは作らない。旧#496をrerunせず、実装・隔離検証・正式CIを通した現在mainで新しい通常実行を使う。

| 項目 | 限定する内容 |
| --- | --- |
| プロジェクト・リージョン | `lip-knots-crew-staging / asia-northeast1`のみ |
| 調べるAPI | `createUploadSession`と`finalizeStagedUpload`の2件だけ |
| 取得するデータ | 公式Functionの`sourceProvenance.resolvedStorageSource`が示す既存source ZIP、最大2個の固定世代 |
| 取得先 | 既存GitHub保護付き検証runnerの一時領域。ZIP本文・コード・秘密値を公開artifactやログへ出さない。新しい長期保存先を作らない |
| 通信 | Function/参照Build/対象オブジェクトだけ、最大12 GET。任意URL、一覧検索、redirect、自動再試行、別identityへの切替は行わない |
| サイズ | 1 ZIP 10 MiB以下、合計20 MiB以下。metadataのsizeを先に検査し、streamの実受信量にも上限を設ける |
| 保存クラス | 本文取得はSTANDARDだけ。不明・他クラス・Requester Pays等で追加条件が必要なら停止する |
| 権限 | 既存の短期WIF identityだけ。`storage.objects.get`等が不足した場合は停止し、ロール・共有・認証設定を追加しない |
| 操作 | sourceの読取とローカル照合だけ。Function呼出し・Build開始・再配備、Storage書込・削除、業務データ操作は含めない |

## 真正性を確認する条件

固定URLと世代番号を公式Functionの応答から結び付け、認証済みHTTPSでその世代を取得する。callerが渡したJSONや自己申告の`verified=true`を根拠にしない。Function名、project/region、対応service/revision、Build参照、ACTIVE/GEN_2/nodejs22、最新revisionへのtrafficを照合する。参照BuildのID・SUCCESSも確認する。取得前後のFunction/Build・source世代が変わったら停止する。

archiveの実バイト数とtransportの整合性を確認し、取得した実コードを、同じCI成功済みmainから作った完全inventoryと照合する。JS/TS・package/lock・case-mail-runtimeの必要ファイルを全て含め、余分な関連コード、秘密ファイル、欠落、変更、危険なZIP構造を拒否する。環境値やimage digestだけでコード一致を代用しない。

これは、欠けたBuildハッシュを無視する変更ではなく、来歴の信頼源を「独立審査済みの保存観測」から「承認されたcollectorによる公式固定世代の実取得」へ追加する変更案。新しい信頼境界を実装・審査する必要があり、現行guardを消したり、未審査のchecksumを採用したりして進めない。新経路の証拠は保存経路と混同しない。

この取得に成功しても、古い配備コードと現在mainが一致するとは限らない。不一致なら配備コード未一致として停止し、対象と差分を報告する。既存API/workerの新配備や停止解除を自動で追加許可したことにはしない。

## 費用と反映条件

上記20 MiB・少数GET・STANDARDという前提で、現在のCloud Storageの転送料と操作料からは1回USD 0.01未満の概算となる。課金通貨・区分・実際の請求額を保証する値ではない。無料とは扱わず、この限定取得の費用可能性を含めて本人に提示する。サイズと回数の制限は実装で強制する。新しい有料resource、常駐処理、定期取得は作らない。

承認対象は、この限定取得を使う方式の実装・隔離検証と、上記上限内での1回の実取得・照合。現在待機中の公開#502（run41036355829、guard成功・promote未実行）は、取得方式を変更した新しい版へ切り替える際に取り下げる対象として、この確認へ含める。現行の「追加費用を認めない保存資料経路」から取得方式を広げるため、#496の公開承認だけでこの追加取得や#502の取消まで許可されたとは扱わない。

コード一致・現在mainの正式CI/有効Preview・既存の両site固定退避/復旧条件を満たした場合だけ、通常の保護付き手順でStaff/Admin2画面を反映する。GAS既存2ファイル＋対象book設定1件は既に承認済みだが、実アプリ入口とログイン確認後の条件を守る。原本の業務セル、実メール、権限、Rules/索引、停止解除、本番への許可は追加しない。

実装前後に、別project/Function/object/generation、403、redirect、サイズ超過、非STANDARD、前後変更、ZIP不正、inventory差分、秘密混入、caller作成の偽証拠、失敗後の追加通信、照合前のHosting操作を隔離試験する。成功した合成試験と実取得の成功は分けて報告する。

## 公式仕様

- [Cloud Build SourceProvenance / BuildOptions](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds)
- [Cloud Storage objects.get：metadata、alt=media、generation、必要権限](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get)
- [Cloud Storage料金](https://cloud.google.com/storage/pricing)
