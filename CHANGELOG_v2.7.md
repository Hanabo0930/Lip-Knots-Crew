# v2.7 変更内容

- 管理画面へ3～5名パイロット配布・監視パネルを追加
- staging限定、参加者・同時開催・安全設定・未解決キューのサーバー側gateを追加
- 既存ワンタイムログイン案内を再利用し、1名でも失敗した場合は自動block
- 10項目を5分間隔で監視し、CONTINUE・WATCH・PAUSEを自動判定
- 異常・復旧・監視失敗を管理者Push、structured log、Firestore証跡へ保存
- 同一アラートcooldown、期間終了時review_required、手動停止を追加
- 次段階への自動拡大とproduction実行を禁止
- パイロット配布・監視判定を10ケースで自動検証
