# サーバー修正の反映準備状況

2026-09-07時点。PR #113〜#116はmain統合済みですがFunctions未反映です。STAGING Hosting成功をこれらの稼働確認とは扱いません。

| 対象 | 修正 | 反映前に揃える条件 |
|---|---|---|
| adminCancelJob / adminSetJobCancellation | 取消時の勤務枠所有者照合 | 両APIの同版、合成案件で再取消と別案件枠の保護を受入 |
| adminEditJobInputs | 担当者変更時の旧枠所有者照合 | 解除/変更/競合時の再試行を合成案件で受入 |
| previewShiftImport | 保存会社設定の混入拒否 | 実原本を使わず、会社不一致と旧設定の互換性を受入 |
| syncShiftSheetsReadOnly / syncShiftSheetsScheduled | 25案件transaction、未反映応募保護、リース600秒と所有者検査 | 手動/定期を同版に揃える。名称にReadOnlyがあっても取込commitはDBを書き換える |

これらは現在のAGENTS.mdのFunctions許可リスト外です。通常の継続指示では許可リストを変更しません。既存のstaging-functions-deploy.yml・validate-staging-scope.mjs・source-integrity検査・保護環境を回避しないこと。Functions反映に必要な範囲の明示承認は、原本取込や本番反映の承認とは別です。

## 実施順序（反映操作は未実行）
1. 指定会社の既存勤務枠を読取診断し、合成テストの結果と実データの受入結果を分ける。現在のSTAGING lipknotsの2コレクションは0件のため、実データ受入は未完了。
2. 原本に接続しない合成テスト専用データ・設定と、その限定書込範囲を確定する。既存設定変更やテストデータ投入は現時点で未実施・未承認。
3. 現行Functionの稼働版、対象関数、既存スケジュール状態、退避版、実表を読まないことを確認し、明示的な反映範囲を確定する。定期関数のデプロイはスケジュール作成/更新を伴うため、通常の手動APIと一括で扱わない。
4. 許可が確定した後、同じCI成功SHAで許可リストと正規ワークフローの整合を確保する。取込の新旧混在期間に実同期を走らせない。現在の手順を解除して手動デプロイしない。
5. 限定した合成案件で取消・再手配・並行応募・リース交代・部分失敗を検証し、診断を再取得する。取消後の経費/写真受付と取消済案件への再手配は業務方針を別途確定する。
6. 不具合時は事前に検証したコード版へ戻す。コードの復元では既に書かれたDB状態は戻らない。データの機械的な修復は別の対象・根拠・退避・承認を必要とする。

本資料は実行計画です。デプロイ済み・実データ検証済み・業務方針承認済みという証跡にはなりません。原本変更/GAS実行/実送信/Production/Rules/IAM変更は引き続き対象外です。

## 2026-09-08 ローカル結合検証の追加
adminCancelJobの古い同期に対する取消保持と、手動/定期取込の読取失敗時停止を修正。詳細は[SHIFT_LIFECYCLE_LOCAL.md](SHIFT_LIFECYCLE_LOCAL.md)。8シナリオは合成境界であり、実SDK並行制御・配信の受入には代用しない。上記Functionsの許可範囲と未配備状態は変わらない。

## 提出処理の反映前条件（2026-09-08）
finalizeStagedUploadと内部submission-status処理に再実行用チェックポイントを追加。Hostingでは配備されない。finalizeStagedUploadは既存Functions許可リスト内だが、今回のHosting業務単位ではFunctionsを配備しない。反映前に旧版の転送済み提出でマーカーがないデータの取扱い、重複イベントと失敗復旧の限定受入、退避版を具体化する。旧データの直接修復/実DB投入は別承認。createUploadSessionや再提出APIは既存許可リスト外で範囲を広げない。Drive成功→チェックポイント保存の窓と同時転送は未保証。詳細は[SUBMISSION_LIFECYCLE_LOCAL.md](SUBMISSION_LIFECYCLE_LOCAL.md)。

## finalizeStagedUpload限定反映の具体条件（2026-09-08・未実行）

- 対象は既存許可内のSTAGING/asia-northeast1/finalizeStagedUploadだけ。内部drive-transfer/submission-statusを同版にする。createUploadSession/再提出API/取込・取消API/定期同期を配備対象へ広げない。
- 正規staging-functions-deploy.ymlのoperation=deploy、source_ref=CI成功済みmain、functions=finalizeStagedUploadを使用する。既存確認文字列・有効化スイッチ・保護環境・同SHA CI・ソース整合・対象認証ガードを守る。gmail-smokeは起動しない。文書等を含む未統合ブランチのsource guardを迂回しない。
- 反映前に稼働revision/配備元SHA/退避可能アーティファクトを読取で確定する。今回その確定は未実施。コード巻戻しと書込済み転送計画/DB状態の保全を分ける。旧版は二重転送の可能性があり、巻戻しだけをデータ復旧と扱わない。
- 旧データを未転送/PR124 checkpointあり/旧版転送済み加算不明に読取分類する。実DB分類は未実施。加算不明は自動再実行停止。予約済みplanは移行時に消さない。
- 受入候補は専用会社/スタッフ/案件/2ファイル合成提出と専用Driveフォルダ/Storage接頭辞。sheetSyncQueue worker/通知配信が原本・実利用者へ到達しない隔離が必要。応答喪失、DB結果保存失敗、同時イベント、不一致を注入しDrive1/連番1/加算1/キュー1を確認する。具体的な隔離先IDと書込/削除範囲は未確定で、クラウド合成投入/実Drive保存/イベント起動は未承認・未実行。
- 必要な判断は隔離先・書込対象・片付け対象の確定とそのデータ操作承認。Functions配備の既存許可を実データ操作へ拡張しない。イベント再実行経路/既存retry設定も読取確認する。

現時点の不足は隔離先/書込範囲、稼働退避版、旧データ分類。ローカル30ケースは完了。詳細[DRIVE_TRANSFER_RECOVERY.md](DRIVE_TRANSFER_RECOVERY.md)。
