# 本番アラート対応キュー v4.2

## 目的

本番証跡のWATCH・CRITICALを担当者付きで追跡し、安全な対応と解決履歴を固定します。

## 状態

- `open`: 未対応
- `acknowledged`: 確認済み
- `in_progress`: 担当者が対応中
- `resolved`: health遷移により解決済み

## 管理画面の操作

1. CRITICALを先に確認します。
2. 実際に対応する管理者が`対応開始`を押します。
3. `安全手順をコピー`し、表示されたコマンドを運用端末で実行します。
4. 状況確認だけの場合は`確認のみ固定`を使います。
5. 証跡同期または5分監視でhealthが変わると旧アラートは自動解決します。

## 強制される安全条件

- production・admin・同一企業だけ操作可能
- 操作直前に現在healthとfingerprintを再計算
- 解決済み、古いアラート、別担当者による上書きを拒否
- クライアントからalert文書へ直接書込不可
- 対応開始、確認、解決はevent・auditへ保存

## phase別の安全手順

- デプロイ・受入監視: `npm run acceptance:production`
- rollback必要: `npm run rollback:production:prepare`
- rollback後の復旧: `npm run acceptance:production:recovery`
- rollback失敗: `npm run rollback:production:preview`
- 復旧失敗・その他: `npm run evidence:production:preview`
