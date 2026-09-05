# Codex作業・検証手順

## 作業フォルダ

このフォルダにはアプリ全ソース、既存設計書、検証スクリプト、新しい引継ぎ資料があります。GitHubを正本にします。ChatGPT側の作業フォルダが自動的に利用者のPCへ配置されるわけではありません。

Codex側にGitHub接続がある場合は対象リポジトリとBatch 48のブランチを開いてください。端末のフォルダを使う場合はcloneしたリポジトリ、または配布スナップショットを展開した `Lip-Knots-Crew` を作業対象にし、ルートの `CODEX_START_HERE.md` を最初に読ませます。

Git cloneが可能なCodexは次で取得できます。利用者本人へのログインが必要な場合だけ依頼してください。

```sh
git clone --branch automation/codex-workspace-submissions-batch48-20260905 https://github.com/Hanabo0930/Lip-Knots-Crew.git
```

配布スナップショットは `.git`、依存パッケージ、秘密設定、ビルド出力を含まない読取・編集用ソースです。継続してPRを作る場合はGitHubの同ブランチをcloneして同じソースか照合します。スナップショットから無関係な新規リポジトリを作成したりmainを上書きしたりしません。

## 環境と安全なローカル確認

リポジトリの指定はNode.js 22と固定の `package-lock.json`。依存更新を兼ねないでください。

```sh
npm ci
npm run build:staff
npm run build:admin
npm run test:bundle-size
npm run test:web-boot-bundles
npm run test:admin-startup
npm run test:staff-company-scope
npm run test:staff-ux-performance
node scripts/test-staff-submission-flow.mjs
npm run test:preview-demo
npm run test:automation-safety
```

Functionsに変更がない場合でもGitHubの既定CIはFunctions検査を実行します。これはデプロイではありません。`npm run verify` はリポジトリ全体の広い検査であり、変更範囲の検証後に理由なく何度も繰り返しません。

### 実画面の確認

Firebaseの実設定がない新しい作業フォルダではデモを利用できます。自分の既存環境に実設定がある場合は、秘密ファイルを表示・共有せず、設定のない独立checkoutを使います。デモの成功をSTAGINGの実データ検証と混同しません。

```sh
npm run dev:staff
```

Staffは `http://localhost:5173`。既存の `npm run preview:demo` とWindows用起動ファイルも使用できます。Firebaseの実設定を推測して新規作成しないでください。

提出のブラウザ検査は次で実行します。ネットワークを通じてPlaywrightのブラウザ本体を取得する必要があります。

```sh
npx playwright install chromium --only-shell
node scripts/test-staff-submission-flow.mjs --browser
```

`LKC_VISUAL_EVIDENCE_DIR` を指定するとStaffホームとシフトの画像を保存します。検査はローカルのデモとコンポーネント用fixtureを使い、メールや実アカウントを使用しません。実設定がある作業フォルダでは実行しないでください。

Batch 48作成環境ではブラウザ取得がタイムアウトしました。次のCodexはまずこの検査を完走させ、失敗なら原因を修正します。ブラウザなしの既定実行はロジック/HTML検査だけであり、実画面のPASSにはなりません。

## GitHubとSTAGING

1. `git status`、main、作業ブランチ、未コミット差分、対応PRを照合。既存の他作業を混ぜない。
2. 変更をまとまりごとに実装し、検証結果・制限を記録。生成された `tsconfig.tsbuildinfo` などを無関係な変更として混ぜない。
3. `automation/*` または `cursor/*` へコミットし、Draft PRを作成。接続経路でcommit SHAが変わる場合は親SHAとtree SHAの一致も検証。
4. PR CIの全ジョブを追跡。ローカルだけで実施した検査をCI実施済みと記載しない。
5. PRごとの明示承認を受けたらHead SHAが承認対象と一致することを再確認し、Ready化・Merge commitを実行。自動マージ機能の有効化やDraft制約の迂回をしない。
6. 最新main SHAを確定し、そのSHAのmain CI→自動Preview→Promoteを追跡。
7. 保護環境の本人承認が必要なら、実行URLと「Review deployments → lkc-staging-hosting → Approve and deploy」を一度に案内。
8. 事前検査、両サイトのバックアップ、反映、事後検査、ロールバック要否、一時チャンネル削除、artifactを確認。

直接の `firebase deploy`、Production操作、Functionsやデータ・IAMの変更をこの手順に追加しません。

## 索引

| 知りたい内容 | ファイル |
| --- | --- |
| Staffの画面・操作 | `apps/staff/src/App.tsx`、`styles.css` |
| 下書き・同時処理 | `draft-store.ts`、`concurrency.ts`、`useAsyncAction.ts` |
| 提出画像 | `SubmissionPreviewImage.tsx` |
| 起動・セッション・キャッシュ | `firebase-config.ts`、`business-cache.ts`、`pwa-update.ts` |
| 管理画面 | `apps/admin/src/App.tsx` と同フォルダのパネル |
| サーバーAPI・データ | `docs/CALLABLE_API.md`、`docs/FIRESTORE_SCHEMA.md`、`functions/src/` |
| 全体構造 | `docs/ARCHITECTURE.md` |
| 既存業務の前提 | `docs/ADMIN_OPERATIONS_V08.md`、`docs/STAFF_IMPORT_READONLY.md` |
| 再提出・通知 | `docs/RESUBMISSION_WORKFLOW.md`、`docs/NOTIFICATION_SCHEDULE.md` |
| クラウド安全規則 | `AGENTS.md`、`config/automation/staging-safety.json`、`scripts/automation/` |
| Git運用 | `docs/GIT_WORKFLOW.md` |

古い版の設計書は参照履歴として残しています。版番号の大きさだけで実運用状態や優先度を決めず、現行ソース・実行証跡・最新の利用者指示を突き合わせてください。
