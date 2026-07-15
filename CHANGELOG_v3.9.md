# CHANGELOG v3.9

## 本番受入

- Project、必須Functions、Staff/Admin Hosting、2画面、2 PWA manifest、Login Gateway、Drive Previewの9項目を自動検査。
- Staff/Admin画面は5種のセキュリティヘッダー、同一origin、HTTP 200、画面markerを検査。
- 5分間隔で3回合格するまで本番受入を固定せず、1件でも失敗したら即時に`rollback_required`証跡を生成。
- 成功済みデプロイ証跡、30分期限、Release・Project・全stage合格を受入前に再検証。

## 既知正常版・ロールバック

- 既知正常ソースからRules、indexes、Storage Rules、Functions buildを専用bundle化。
- 全ファイルSHA-256、manifest指紋、ファイル台帳、symlink・path escape・余計な混入を検査。
- 受入失敗時だけ、Rules/Storage→Functions→Staff Hosting clone→Admin Hosting cloneの順で復旧。
- 別承認者、15分TTL、6確認、受入台帳・bundle・rollback計画の指紋一致を必須化。
- 失敗stageで後続を停止し、緊急停止を維持。成功後も旧版専用台帳で9項目を3回再検査するまで解除しない。

## 画面・設定・検証

- 本番セットアップを8ファイルから10ファイルへ拡張し、受入設定とロールバック設定を自動生成。
- 管理画面に本番受入・自動rollback指揮コンソールを追加。
- Windows用の本番受入、ロールバック、復旧受入フローを追加。
- Hostingへ5種のセキュリティヘッダーを追加。
- 受入52件、既知正常bundle14件、ロールバック53件を含む自動検証を追加。
