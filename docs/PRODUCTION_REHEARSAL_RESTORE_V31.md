# 本番移行リハーサル・復元演習 v3.1

## 実行順序

1. 30〜50名3waveと最終観察を完了する。
2. stagingの変更を凍結し、対象Release IDを固定する。
3. Firestore export、Storage manifest、Auth exportを取得する。
4. stagingとは別の隔離Projectへ復元する。
5. Security Rules・Indexesを復元する。
6. 元・復元の件数、snapshot SHA-256、標本、権限、smokeを検算する。
7. 本番移行をdry-runし、予定件数と適用件数を一致させる。
8. snapshotへ切り戻し、RTO・RPO・smokeを計測する。
9. 全項目合格後に証跡fingerprintを固定する。

## 強制条件

- source環境はstagingのみ
- source Projectとrestore Projectは別
- restore Project名は`restore`、`drill`、`rehearsal`のいずれかを含む
- Firestore・Storage・Authの元件数と復元件数が完全一致
- 元・復元snapshot SHA-256が完全一致
- 標本差異、権限probe失敗、復元後smoke失敗が0件
- 移行予定件数とdry-run適用件数が一致し、移行差異0件
- 切戻しRTO 60分以内、RPO 5分以内、切戻し後smoke失敗0件
- 証跡参照7件以上

## 公開ゲート連携

`productionRehearsalCertifications/{stagedRolloutId}`が合格状態で存在するときだけ、本番公開ゲートの「バックアップ」「復元演習」「移行計画」「切戻し計画」が自動で合格する。管理画面のチェック操作だけでは合格にできない。

## CLI preview

`npm run rehearsal:production:preview`

previewは外部変更を実行せず、実行順序、対象Project、コマンド、fingerprintだけを表示する。実コマンドは各工程の承認後に個別実行し、結果を管理画面へ記録する。

