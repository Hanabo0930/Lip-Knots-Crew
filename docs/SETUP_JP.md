# セットアップ手順

## 1. 必要環境

- Node.js 22
- Firebase CLI
- Google Cloud／Firebaseプロジェクト
- info@lipknots.comで管理可能なGoogle Workspace
- Google Sheets／Driveへの共有権限

## 2. インストール

```bash
npm install
```

## 3. Firebase設定

`.firebaserc.example` を `.firebaserc` へコピーし、プロジェクトIDとHostingサイトを設定します。

スタッフ・管理者アプリの `.env.example` を `.env.local` へコピーし、Firebase Web App設定を入力します。

## 4. ローカル起動

```bash
npm run emulators
npm run seed
npm run dev:staff
npm run dev:admin
```

## 5. Firebase Consoleで有効化

- Authentication
  - Email link
  - Google
- Firestore
- Storage
- Cloud Messaging
- Functions
- Hosting
- App Check（本番前）

## 6. 管理者

Functionsの環境変数 `ADMIN_EMAILS` に管理者メールを設定します。

例:

```text
info@lipknots.com
```

## 7. Google Sheets

Functionsの実行サービスアカウントへ対象スプレッドシートを編集者共有します。

本番では、監査後に確定した列マッピングを
`companies/lipknots/sheetMappings/shift`
へ保存します。

## 8. Google Drive

Functionsの実行サービスアカウントへ「報告書・画像」のルートフォルダを編集者共有します。

`companies/lipknots/settings/drive` へルートフォルダIDを保存します。

## 9. 本番メール

v0.1のスタッフ画面はFirebase標準のメールリンク送信を使います。

正式版では、Functionsでログインリンクを生成し、Google Workspace／Gmail API等を介して
`staff@lipknots.com`
から送信する方式へ切り替えます。
