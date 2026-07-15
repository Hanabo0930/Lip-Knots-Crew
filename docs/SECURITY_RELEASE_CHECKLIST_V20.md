# セキュリティ最終チェック v2.0

- Firestoreルールのクロステナント拒否
- StorageパスのtenantId分離
- SuperAdmin権限の分離
- 本番Secretがソース・ZIP・Driveへ入っていない
- Stripe Webhook署名検証
- Webhook冪等処理
- スプシ書込の排他制御
- GAS監査blocker 0件
- メール二重送信防止
- 監査ログの改ざん防止
- バックアップ復元試験
- 退職・契約終了者の権限失効
- 個人情報の保持期間と削除手順

未確認項目がある状態で正式公開しません。
