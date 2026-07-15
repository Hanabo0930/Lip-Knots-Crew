# CHANGELOG v4.2

- 本番証跡アラートを永続キュー化
- CRITICAL優先、未解決・確認済み・対応中・解決済みの集計を追加
- `startProductionEvidenceAlertResponse` Callableを追加
- 担当者競合、古いfingerprint、解決済み操作をサーバーで拒否
- health遷移に合わせて旧アラートを自動解決
- phase別の安全なrunbookとコピー操作を追加
- Firestore alert subcollectionの企業分離・直接書込拒否を追加
- 管理画面を本番アラート対応キュー指揮盤へ更新
- 必須Functionsを10本から11本へ更新
- 対応キュー・差分監視48件、権限・安全性30件へ拡張
