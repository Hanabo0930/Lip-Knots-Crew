# 本番SLA既読・再通知・自動昇格 v4.6

## 自動運用

- 毎週月曜09:00 JST以降、`ADMIN_EMAILS`の各本人へ週次レポートを1回配信
- 本人は自分宛てだけを既読に固定
- 未読は24時間ごとにLEVEL 1、2、3へ再通知し、3回で停止
- 再発防止レビューは期限前、超過24時間未満、24時間、72時間でLEVEL 0、1、2、3
- LEVEL 3は管理者全体へ昇格し、静穏時間をバイパス

## 証跡

`productionReleaseEvidence/{evidenceId}/weeklyReports/{weekKey}/recipients/{recipientId}`に本人別状態を保存します。識別子はメールのSHA-256由来で、UIDは管理画面へ返しません。全操作はイベントと`auditLogs`へ固定し、クライアント直接書込は拒否します。

## 本番確認

1. Node 22で15 Functionsをデプロイする。
2. `ADMIN_EMAILS`の全メールにFirebase Authユーザーがあることを確認する。
3. 本人の既読だけが受理され、他人宛てが変更できないことを確認する。
4. 24・48・72時間の再通知とLEVEL 3昇格をテスト用証跡で確認する。
