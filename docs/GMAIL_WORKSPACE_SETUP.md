# staff@lipknots.com Gmail送信設定

## 必要な作業

1. Google Cloudで専用サービスアカウントを作成
2. サービスアカウントでドメイン全体の委任を有効化
3. Google Workspace管理コンソールで次のスコープを許可
   - `https://www.googleapis.com/auth/gmail.send`
4. サービスアカウント鍵JSONをFirebase Secretへ登録

```bash
firebase functions:secrets:set GMAIL_SERVICE_ACCOUNT_JSON
```

5. Functionsパラメータを設定
   - MAIL_FROM=staff@lipknots.com
   - STAFF_APP_URL=https://staff.lipknots.com/
   - PUBLIC_LOGIN_GATEWAY_URL=デプロイ後のloginGateway URL

## 注意

- 秘密鍵JSONをGitやZIPへ入れない
- サービスアカウントはメール送信専用
- 委任対象はstaff@lipknots.com
- 送信履歴と失敗理由はFirestoreへ保存
