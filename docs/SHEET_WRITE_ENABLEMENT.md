# 本番書込の有効化手順
1. GAS安全監査レポートを確認
2. 既存GASを列見出し参照へ修正
3. 検証コピーへ案件ID列と必要列を追加
4. mappingの列を実物に合わせる
5. `allowVerifiedFallbackRow:false`のまま案件IDを投入
6. 応募1件、事前連絡1件、ネットプリント1件をテスト
7. 請求・支払・外注合計、PDF、条件付き書式を旧版と突合
8. 問題がなければ本番mappingを`enabled:true`

案件ID列がまだない間にフォールバックを使う場合は、検証環境だけで`allowVerifiedFallbackRow:true`にします。
