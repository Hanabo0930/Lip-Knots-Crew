# Webhook安全設計 v1.8

- 署名検証
- 5分以内のリプレイ許容
- eventIdによる冪等処理
- payload hash保存
- 同一イベントの二重処理拒否
- 失敗時の再試行
- 最終失敗はdead letterへ退避
- tenantId不明イベントは自動適用しない
