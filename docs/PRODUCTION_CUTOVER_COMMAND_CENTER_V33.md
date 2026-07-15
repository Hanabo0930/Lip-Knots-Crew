# 本番切替当日指揮盤 v3.3

## 目的

署名承認済みReleaseの本番切替を、準備、実行、監視、切戻し、完了まで一つの指揮盤で固定します。管理画面の表示だけでなく、Functions側が本番有効化と全体停止を強制します。

## checkpoint

| 時刻 | 必須行動 |
|---|---|
| T−60 | 変更凍結、バックアップ参照、切戻し・移行責任者を確認 |
| T−15 | 署名承認、監視、連絡網、サポート、smokeを最終確認 |
| T±0 | 別管理者がT±5分以内に同一Releaseを有効化 |
| T＋5 | 認証、Functions、p95、smokeを観測 |
| T＋30 | スプシ、通知、queue、データ差異を観測 |
| T＋120 | 拡張監視と切戻し要否を確定 |
| T＋24h | 連続正常12runを確認して完了固定 |

## 判定

- `GO`: 全必須条件合格。preflight時だけ本番有効化可能
- `WATCH`: 閾値接近。観測を継続し、状態変化を管理者へ通知
- `PAUSE`: 準備不足、観測不足、軽度閾値超過。新しい判断を停止
- `ROLLBACK_REQUIRED`: smoke失敗、データ差異、重大障害、重大エラー率、30分監視断など。切戻し開始が必要
- `COMPLETE`: T＋24時間経過、全条件合格、連続正常12run

## 本番有効化の強制条件

`enableProductionRelease`は、指揮盤が`ready`、判定`GO`、phase`preflight`、Release一致、署名パッケージ一致、T±5分をすべて満たさない限り拒否します。有効化後は指揮盤を`monitoring`へ遷移させます。

## 切戻し

`ROLLBACK_REQUIRED`判定時だけ、確認文`LOCK_AND_START_ROLLBACK`と理由を指定して実行します。実行すると`productionEnabled=false`と`emergencyLock=true`を同一transactionで固定します。アプリ内解除APIはありません。

## 証跡

準備証跡3件以上、観測証跡2件以上を必須とします。run、観測、公開権限、緊急イベント、auditLogsを監査対象として保持します。
