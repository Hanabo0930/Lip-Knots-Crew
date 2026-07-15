# Lip Knots Crew

株式会社Lip Knotsの試食販売スタッフ／管理者向けPWAです。

現行版: **v5.6.0 未達原因・改善再実行統制盤**

## v5.6

- 成果未入力・効果悪化・目標未達・ROI赤字を決定的に自動診断
- 実行手順、工程設計、人員・資源、採算・投資、測定設計、外部要因へ原因分類
- 原因根拠・改善案・期限を監査証跡へ固定
- 元タスクの担当者へ改善再実行タスクを自動生成・通知
- recovery_v1判定、冪等指紋、企業分離、UID非公開
- 成果CSVへ改善状態・原因・推奨策・再実行タスクIDを追加

## デモを見る

配布ZIPを解凍し、Windowsで **アプリを見る_WINDOWS.cmd** を実行します。

- 選択画面: http://127.0.0.1:4172
- スタッフアプリ: http://127.0.0.1:4173
- 管理画面: http://127.0.0.1:4174

必要環境はNode.js 22です。デモはFirebase本番環境を変更しません。

## 開発

    npm ci
    npm run verify

モノレポ構成:

- **apps/staff**: スタッフPWA
- **apps/admin**: 管理者PWA
- **functions**: Firebase Functions
- **scripts**: 本番準備・受入・検証ツール
- **config-samples**: 秘密値を含まない設定例

## Git運用

mainを正本とし、作業は短命ブランチ、検証後にPull Requestで統合します。秘密値、環境変数の実値、生成済みconfig、node_modules、配布ZIPはコミットしません。

詳細は[Git運用手順](docs/GIT_WORKFLOW.md)を参照してください。
