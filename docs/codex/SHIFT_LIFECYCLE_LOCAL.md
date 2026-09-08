# 募集・応募・取消・再同期のローカル結合検証

2026-09-08。実シート・クラウドDB・GAS・メールへ接続しない合成検証。

## 再現

固定依存を持つ環境で `node scripts/test-shift-lifecycle.mjs`。
WindowsではH正本から `pwsh -File scripts/test-windows-local.ps1 -Task Prepare` を実行し、出力されたC検証キャッシュで同じコマンドを実行する。H正本を直接検証する場合は、既存の `LKC_TEST_DEPENDENCY_ROOT` に固定依存キャッシュのルートを指定できる。CからHへソースは戻さない。

seedはこの検証で実行しない。既存seedにはSDK import/初期化より前のdemo-* project、別名projectの一致、Auth/Firestore両方のloopbackと有効ポート検査を追加。`node scripts/test-emulator-seed-safety.mjs` は23ケースで設定検査だけを実行する。

## 実装をまたぐ範囲

shift-import → sheet-reader → shift-parser → case-id と、jobs → utils / system-safety / notification-core / notification-time の**実TypeScriptモジュール全体**をコンパイルして同じDB境界に接続する。関数本文の抜粋や業務ロジックの複製はしない。zod、HttpsError、Timestampは固定依存の実装。未許可importを拒否し、アプリ側には実Firebase接続・Google認証・HTTP・メール送信手段を渡さない。

DBはインメモリ。transactionの読取先行、書込の一括適用、失敗時の未適用、update対象存在、undefined拒否を検査するが、Firestore SDKの再試行・分離レベル・並列競合・Rulesは保証しない。Callable登録境界は合成で、実utilsのrole/company判定を通すが、Authトークンの署名検証・HTTP・App Checkは対象外。Sheets APIは合成応答。通知/書戻しはキュー生成までで、workerをロードせず送信しない。JavaコマンドとローカルEmulatorキャッシュが見つからず、今回はFirestore/Auth Emulator未使用。

## 8つの結合シナリオ

- B空/Fありは募集、Bあり/F空は確定、必須不足はdraft、取消優先、ASとの区別、非表示タブ除外。
- 取込→応募/確定→同requestId再送→同日別案件拒否→古い同期拒否→B一致→取消→古い同期→別案件応募→再取消→原本相当の合成取消値との一致。案件状態と勤務枠所有者、通知/書戻しキューを照合。
- Bへ反映前の応募を取消し、空欄の再同期でも取消を維持。
- 30案件の第2chunk失敗で最初の25件を保持しrunはerror。再試行で30件になり重複なし。
- 第1chunk後のリース交代で次のchunkを停止。旧所有者のfinallyは後任リースを削除しない。
- 全タブ読取失敗はerror、案件書込なし、リース解放。
- 後続タブ読取失敗も案件反映前に停止。previewの警告診断は維持。
- 未認証/他社応募を実claim guardで拒否しキュー/勤務枠を作らない。

## 再現した欠陥と修正

修正前は取消後の古いシート値によりassignedへ戻る経路とopenへ戻る経路、読取失敗なのにcompletedを返す経路が失敗した。adminCancelJobに既存analyticsと同形式のappOverride(cancel)およびpublishable:falseを追加。commitはタブ読取失敗時にunavailableで停止し、runをerrorにする。previewは警告付き診断を維持。

修正後8シナリオ、seed検査23、既存取消24/取込48/リース6、Functions全体型ビルド成功。CI functions jobへ新検査を追加。Hローカル証跡はrelease-evidence/shift-lifecycle/local.json。

## 未保証・未反映

25件単位の部分commitは既存設計のまま。成功済み25件まで全体rollbackするものではない。実並行応募、通信応答喪失、実サービスでの配信、取消後の経費/写真受付、取消済案件の再手配方針は別受入。

FunctionsのadminCancelJob / syncShiftSheetsReadOnly / syncShiftSheetsScheduledは許可リスト外で未配備。Hostingの反映はサーバー修正の配備を意味しない。原本列BCは合成専用で採用列未決。実データ投入/原本同期/GAS/送信/Rules/IAM/Productionは実行しない。
