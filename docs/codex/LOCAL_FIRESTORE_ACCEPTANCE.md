# ローカルFirestoreによる業務受入

確定仕様の応募・同日重複防止・担当確認・事前連絡・印刷・原本保護を、ビルド済みhandlerと実Firestore Admin SDKで確認する。DBは毎回新規の `demo-lkc-accept-*` プロジェクトを持つPC内エミュレーター。Sheetsの読書きは合成セル、Storage/Driveは合成ファイルの境界に置き換える。

## 検証範囲

- 別スタッフからの同時応募は1人だけ確定し、勤務枠・書戻し依頼・通知記録を重複作成しない。
- 同じ応募の並行再送は同じ受付結果へ収束する。
- 同一スタッフによる同日2案件の応募は片方だけ成立する。
- 合成原本のB空欄・F入力は募集可。取込→応募→管理確認→合成原本反映→再取込→事前連絡の一往復を通す。
- 原本確認前は準備を拒否。停止中のworkerと定期再試行はDB記録も合成原本も変更しない。
- 管理確認・事前連絡・印刷済みの並行再送で、監査や依頼を重複作成しない。
- 会社・役割・現在担当が違う操作を拒否する。
- 書込み直後の応答喪失では結果未確認として保持し、再呼出でも再書込みしない。

- 提出受付の並行再送を同じ受付へ収束させ、並行転送と完了イベント再呼出で件数・反映依頼を二重加算しない。
- ファイル単位と提出単位の両方で、再提出依頼→差替え→管理者確認までを通す。全ファイルが揃う前の完了を拒否し、元ファイルと新旧履歴を保持する。

## 実行

Node 22、Java 21以降、既存lockfileの依存、Functions buildが必要。

```text
npm ci
npm run build -w @lkc/functions
node scripts/test-local-firestore-acceptance-safety.mjs
node -e "require('firebase-tools/lib/emulator/downloadableEmulators').downloadIfNecessary('firestore')"
node scripts/run-local-firestore-acceptance.mjs --java <java実行ファイル> --jar <Firestore emulator JAR> --evidence <未使用の証跡フォルダ>
```

JARの保存先は `node -p "require('firebase-tools/lib/emulator/downloadableEmulators').getDownloadDetails('firestore').downloadPath"` で確認できる。runnerはlockfileで導入したFirebase CLIの固定サイズ・SHA256と一致するJARだけを使用する。Javaのインストール、OS設定変更、クラウドへの配備を行うスクリプトではない。

## 隔離と終了

runnerは既存のDBへ接続せず、新しいloopbackポートにエミュレーターを起動する。Firestore以外のエミュレーターやFunctionsイベント配信は起動しない。子プロセスへ渡す環境変数を限定し、認証設定の探索先を空の専用フォルダへ分離、クラウドのメタデータ探索を無効にする。SDK初期化前にdemoプロジェクトと接続先を検証し、業務SDKが使うTCP接続をそのポートに限定する。予期しない外部接続試行は遮断し、総合結果を失敗にする。

ログ・結果・実行したJSのSHA256を証跡へ保存する。終了・タイムアウト・中断時に今回起動したプロセスを停止する。実DBの一括削除APIや、既存エミュレーターのデータ消去は使わない。DB内容はこのプロセスのメモリだけに保持する。

## 限界

認証情報は合成のcallable contextを与えるため、IDトークンの署名検証・実ログイン・Security Rulesの受入ではない。Sheets・Drive・FCM・実メール・実端末の動作も実証しない。エミュレーター成功を、実クラウドの索引・性能・全トランザクション動作の保証や、実原本への書込み許可へ置き換えない。P1の実利用受入は別に残る。

[Firebase公式の接続・制約説明](https://firebase.google.com/docs/emulator-suite/connect_firestore)に従い、demoプロジェクトとローカル接続を使用する。

