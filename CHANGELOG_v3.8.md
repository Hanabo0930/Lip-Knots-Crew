# CHANGELOG v3.8

## 承認付き本番デプロイ

- 本番計画をSHA-256指紋で固定し、64文字完全一致の確認入力を必須化。
- 承認者、変更票、対象Project、Release、scope、30分TTL、5安全確認を実行直前に再検証。
- Firebase認証・Project照合後、Rules・Storage → Functions → Staff/Admin Hostingの3段階実行。
- 失敗stageで即停止し、後続stageを実行しない制御を追加。
- Functions一覧、Hosting site一覧、Staff/Admin HTTPS markerの事後確認を追加。

## 証跡・復旧

- 実行結果を`release-evidence/production/deployment-result.json`へ保存。
- 失敗時に全体停止、Hosting、Functions、Rulesの復旧手順を`rollback-plan.json`へ生成。
- token、Authorization、秘密鍵文字列を証跡から自動マスク。
- 実承認JSONと実行証跡をGit・ZIP対象外に固定。
- Windows用の承認作成・検査・ビルド・指紋確認・実行フローを追加。

## 管理画面・検証

- 管理画面に5工程、承認TTL、指紋、安全確認、証跡状態を表示する本番デプロイ指揮コンソールを追加。
- デモは`PREPARED / NOT DEPLOYED`を明示し、外部変更を行わない。
- 計画・承認・失敗停止・証跡マスク・復旧計画・CLI previewを39ケースで検証。
