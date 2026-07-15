# CHANGELOG v3.3

- T−60からT＋24時間までの本番切替当日指揮盤を追加
- 7 checkpointと9項目の準備確認を管理画面へ追加
- 12種類の本番観測値からGO・WATCH・PAUSE・ROLLBACK_REQUIRED・COMPLETEを自動判定
- 同一状態の通知連打を防ぐ安定SHA-256 fingerprintを追加
- 5分監視と10分・30分の監視鮮度判定を追加
- 本番有効化をT±5分・PREFLIGHT GO・同一Release・同一署名パッケージへ強制連動
- 自動切戻し要求時だけ実行できる不可逆な全体停止を追加
- T＋24時間・連続正常12run・本番正常稼働を完了条件化
- Firestore Rules、index、監査証跡、管理者Pushを追加
- 指揮盤判定・有効化ゲート42ケースを追加
