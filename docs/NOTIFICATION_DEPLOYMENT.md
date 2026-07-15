# 通知基盤の導入順

1. Firebase本番プロジェクトを設定
2. Web PushのVAPIDキーを発行
3. スタッフ・管理者`.env`へVAPIDキーを設定
4. `notificationSettings/lipknots`へ設定サンプルを登録
5. 最初は`enabled:false`
6. Functions、Firestore indexes、Rules、Hostingをデプロイ
7. テストスタッフ1名・管理者1名で通知許可
8. 通知テスト
9. 応募確定・キャンセル通知テスト
10. 事前連絡の時刻をテスト環境で短縮して確認
11. 売場画像・報告書期限通知テスト
12. 22:00〜7:00の繰越・7:00まとめ通知テスト
13. `notificationSettings/lipknots.enabled=true`
14. 5〜10名で試験
15. 30〜50名
16. 約200名へ展開
