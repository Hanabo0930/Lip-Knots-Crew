# 本番リリース手順 v2.0

## 前提

このZIPは正式リリース候補です。実本番へ接続する前に、リリースゲートの全blocking項目を合格させます。

## 手順

1. v2.0 ZIPを変更禁止の基準版として保存
2. development・staging・productionのFirebaseを分離
3. stagingへデプロイ
4. 既存GAS全コード監査
5. 検証コピーでスプシ書込・請求・給与・PDF・メールを回帰試験
6. `PILOT_DISTRIBUTION_MONITORING_V27.md`に従い3～5名パイロット
7. バックアップ作成・復元試験
8. 監視・エラー通知を確認
9. 本番SecretをSecret Managerへ登録
10. 本番データ移行
11. リリースゲート再判定
12. 社長の明示承認
13. 本番デプロイ
14. 24時間・72時間・7日後の確認

Productionへの自動デプロイは初期状態では無効です。
