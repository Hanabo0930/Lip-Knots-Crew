# アーキテクチャ

## 採用構成

- Frontend: React + TypeScript + Vite
- PWA: vite-plugin-pwa
- Authentication: Firebase Authentication
- Database/index: Cloud Firestore
- Backend: Cloud Functions for Firebase 2nd gen
- Push: Firebase Cloud Messaging
- Upload staging: Cloud Storage for Firebase
- Final files: Google Drive
- Operational source: Google Sheets
- Hosting: Firebase Hosting
- Local testing: Firebase Emulator Suite

## データの役割

### Google Sheets
社長が使う業務上の基準データ。既存の数式・GAS・請求・給与連携を維持する。

### Firestore
高速一覧、検索、状態、先着制御、通知、監査、ファイル連番を担当する。

### Cloud Storage
大容量画像・PDFを再開可能な形で一時受信する。

### Google Drive
クライアント共有を含む最終保管場所。

## 書き込み原則

スタッフ端末からGoogle Sheetsへ直接書き込みません。

1. スタッフ操作
2. Callable Functionで認証・検証
3. Firestoreトランザクションで状態確定
4. sheetSyncQueueへ登録
5. Functionsが許可列だけGoogle Sheetsへ反映
6. 成否を監査ログへ保存

## 先着応募

`staffDayLocks/{companyId_staffId_YYYY-MM-DD}` を同じトランザクション内で確保します。

- 案件がopenか
- 担当者が空か
- 募集停止・キャンセルでないか
- 同日ロックが存在しないか
- idempotencyKeyが未使用か

を確認し、一度に確定します。
