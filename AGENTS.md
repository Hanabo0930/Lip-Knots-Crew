# Lip Knots Crew agent guardrails

These rules apply to every automated coding agent working in this repository.

## Fixed environment

- The only deployable project in unattended workflows is `lip-knots-crew-staging`.
- The only allowed region is `asia-northeast1`.
- Production access, production deploys, and production credentials are prohibited.
- Never print secrets, access tokens, ID tokens, environment files, personal data, or complete cloud resource policies.

## Git safety

- Work on a dedicated `cursor/*` or `automation/*` branch.
- Never push directly to `main`.
- Standing user authorization (2026-09-05): merge ordinary development PRs in the requested scope without asking for per-PR approval, only after all required checks succeed for the exact current Head SHA. Mark Draft PRs ready, then use a Merge commit with an exact-head guard. Stop on failed checks, unexpected changes, or conflicts; never bypass branch or environment protections. This does not authorize production access, real messages/data changes, or cloud changes beyond the existing explicit scope.
- Never rewrite shared history or use destructive Git commands.
- Keep unrelated changes out of the current task.

## Allowed autonomous work

- Read repository state and pull-request context.
- Edit source, tests, documentation, and workflow files within the requested scope.
- Run `npm ci`, scoped builds, and repository tests.
- Create or update a dedicated branch and draft pull request.
- Report results through GitHub checks and pull-request comments.

## Operator-effort rule

- Automate repository inspection, edits, checks, safe retries, evidence capture,
  and draft pull-request creation.
- Do not ask the operator to paste or run commands when an existing connector
  or an allowlisted GitHub workflow can perform the same task safely.
- Reserve operator action for interactive login, permission grants, protected
  environment approval that cannot be performed through the authorized staging review API, billing/legal decisions, and
  production approval.

## Cloud safety

The only Functions allowed in the first unattended staging deployment phase are:

- `bootstrapSession`
- `requestStaffLoginLink`
- `getSubmissionTimeline`
- `getSubmissionProcessingStatus`
- `getResubmissionComparison`
- `driveFilePreview`
- `finalizeStagedUpload`
- `registerDeviceSession`
- `heartbeatDeviceSession`
- `listMyDevices`
- `revokeMyDevice`
- `revokeAllMyDevices`
- `getStaffDevices`
- `adminRevokeStaffDevices`
- `registerPushToken`
- `unregisterPushToken`
- `getPushStatus`
- `sendTestPush`
- `processNotificationQueue`
- `confirmApplication`
- `createResubmissionRequest`
- `getMyResubmissionRequests`
- `getAdminResubmissionRequests`
- `completeResubmissionRequest`
- `getExpenseReview`
- `saveExpenseReviewDraft`
- `completeExpenseReview`
- `getJobSheetLink`
- `markNetPrintPrinted`
- `adminCancelJob`
- `duplicateAdminJob`

Never use `firebase deploy --only functions`. Every Functions deployment must list
each function explicitly and pass `scripts/automation/validate-staging-scope.mjs`.
The source branch must also pass
`scripts/automation/check-deploy-source-integrity.mjs`; workflow files,
Firebase configuration, dependency manifests, environment files, and automation
guards cannot be changed by the deployment source branch.

The only Cloud Run services whose Invoker IAM check may be changed are:

- `requeststaffloginlink`
- `getsubmissionprocessingstatus`
- `drivefilepreview`
- `listmydevices`
- `registerdevicesession`
- `heartbeatdevicesession`
- `revokemydevice`
- `revokeallmydevices`
- `getstaffdevices`
- `adminrevokestaffdevices`
- `registerpushtoken`
- `unregisterpushtoken`
- `getpushstatus`
- `sendtestpush`
- `confirmapplication`
- `createresubmissionrequest`
- `getmyresubmissionrequests`
- `getadminresubmissionrequests`
- `completeresubmissionrequest`
- `getexpensereview`
- `saveexpensereviewdraft`
- `completeexpensereview`
- `getjobsheetlink`
- `marknetprintprinted`
- `admincanceljob`
- `duplicateadminjob`

Do not add or remove `allUsers` or `allAuthenticatedUsers` IAM bindings. Do not
change organization policy, project-wide IAM, Firestore data, Storage data,
Rules, or any resource outside the explicit allowlist.

The only Hosting targets allowed in unattended workflows are:

- `hosting:staff`
- `hosting:admin`

Hosting automation must use `.github/workflows/staging-hosting-preview.yml` and
`.github/workflows/staging-hosting-promote.yml`. A successful canonical CI run
on `main` may create expiring preview channels. Live staging promotion must:

- use the exact versions already validated in preview channels;
- require `PROMOTE_LKC_STAGING_HOSTING`;
- pass the protected `lkc-staging-hosting` environment; standing user authorization (2026-09-05) permits the agent to submit its normal approval through the existing authorized GitHub pending-deployments API after verifying the exact current main SHA, successful canonical CI and Preview, the expected promotion workflow and successful guard, and this environment only. Do not remove reviewers, alter environment/branch protection, add credentials, or bypass a denied approval. Ask the operator only if the existing identity cannot approve;
- back up both current live channels before changing either;
- automatically restore both backups if promotion or post-promotion browser
  checks fail.

Never deploy Hosting directly from an application branch, rebuild during
promotion, or deploy Functions, Firestore, Storage, Rules, IAM, or production
from a Hosting workflow.

The staging Gmail smoke may invoke `requestStaffLoginLink` exactly once from
`.github/workflows/staging-functions-deploy.yml`. It must:

- run only from `main` and only in `lip-knots-crew-staging`;
- use the protected recipient secret without printing the address;
- keep the protected Gmail delegated sender and smoke recipient in separate
  secrets, and reject the run before invocation if their addresses match;
- reject GitHub workflow reruns before invoking the Function;
- validate the fixed Function, gateway, delegated user, and bound Gmail secret;
- use the observer identity for read-only delivery verification;
- perform no direct Firestore write and never open the emailed login link;
- fail if zero, multiple, failed, or incomplete delivery records are observed.

The expected indirect staging writes are limited to the Function's own rate
limit, login gateway token, and one delivery record for the single test email.
No other Firestore data, Storage data, IAM, Hosting, or production resource may
change during this smoke.

The only direct Firestore bootstrap exception is the operator-run script
`scripts/automation/provision-staging-gmail-smoke-recipient.sh`. It may create
or replace exactly these two dedicated staging documents:

- `staffProfiles/staging-gmail-smoke-recipient`
- `emailIndex/{sha256(the protected staging smoke recipient)}`

The script must require the exact staging project, the `info@lipknots.com`
operator account, an explicit confirmation, and a dedicated
`info+lkc-staging-smoke...@lipknots.com` alias. It must back up both prior
documents, reject conflicts before mutation, commit the two writes atomically,
and verify both documents afterward. This exception does not permit deletion,
IAM changes, production access, or direct Firestore writes from GitHub Actions.

## Stop conditions

Stop without expanding scope when:

- the project, region, branch, function, or service differs from the allowlist;
- app-level authentication or authorization checks are missing;
- the effective Invoker IAM policy cannot be determined;
- a required GitHub check is not successful;
- a Hosting promotion does not reference the current CI-passing `main` commit;
- a Hosting preview cannot recover the current public Firebase client config;
- the required Hosting backup channels cannot be created;
- a cloud command fails for a reason not explicitly handled by the workflow;
- a deploy would require production access, a long-lived key, or a broader IAM role.

## Completion report

Every agent result must state:

- `SCOPE`
- `FILES_CHANGED`
- `CHECKS_RUN`
- `CHECKS_RESULT`
- `DEPLOY_PERFORMED`
- `CLOUD_RESOURCES_CHANGED`
- `BLOCKERS`
- `NEXT_SAFE_ACTION`

## 実業務シフト表の保護（2026-09-06のユーザー明示指示）

ユーザーが共有したGoogle Sheets「シフト表」は最重要の実業務原本であり、現時点では読取専用。セル値・数式・背景色・タブ・共有設定の変更、アプリからの書戻し、実表を使う取込commit・同期起動を実行しない。通常PR/マージ/STAGING Hostingの包括承認を、この原本や実データの変更許可と解釈しない。検証はローカル合成データで行う。本人がこの原本の操作を別途明示的に許可するまで維持する。
## 完成優先の自律開発（2026-09-15 最新ユーザー指示）
- 完成状態の唯一の入口は docs/codex/COMPLETION_BOARD_20260911.md 冒頭。docs/APP_COMPLETION_STATUS.md と同等の既存管理表として使用する。最初は冒頭の現状だけを読み、履歴・引継ぎ5文書・リポジトリ全体の無条件再解析をしない。
- 確定要件を凍結し、P0 → P1 → リリース検証。P0/P1がある間はP2/P3の新規着手をしない。通常コード修正/関連横断修正/設定/検査/安全な整理/資料/リリース準備は包括承認済みで、実装方法を理由に確認待ちにしない。
- まとまった完成単位で原因特定→根本修正→関連検査/回帰→管理表更新→次の優先課題を連続実行する。報告だけで区切らない。影響しない作業は質問中も続行する。
- 調査済み根拠はSHA・依存・対象・条件・証跡を再利用。同条件の成功済み検査は反復しない。小規模は関連検査、複数機能は関連+統合、P0は影響範囲、最終候補は必須総合検査。失敗は回帰/既存/環境要因を区別する。
- 品質優先。複雑設計/原因不明/多モジュール/セキュリティ/整合性/最終検査はAstraと十分なReasoning。現在はAstra Highを維持。明確な文言/CSS/機械変更は軽い推論またはSolで足りるかを判断するが、小変更を理由に必要検査を省かない。モデル設定相談で開発を止めない。サブエージェントは作らない。
- 現在状態は管理表へ一度記録し、他の引継ぎは参照リンクだけにする。新しい問題はP0/P1なら順序付けし、P2/P3なら記録のみ。
- 仕様/ビジネスルールが変わる重大な曖昧さや矛盾だけ質問する。質問は回答最上部に【🚨 社長確認必須】、内容/選択肢/影響/推奨を簡潔に。本人にしかできない操作は【🚨 社長操作必要】。同じ回答/承認を繰り返し求めない。
- 報告はユーザー指定の【今回完了】【テスト結果】【残りP0】【残りP1】【次に処理】【🚨 社長確認】を優先し短くする。主観的完成率は出さず管理単位の残件と必須条件を示す。
- 既存の本番アクセス禁止、明示範囲外の実データ/実送信禁止、実業務シフト原本読取専用、正規CI/ガード/環境保護は維持する。

## 承認待ちで停止（2026-09-16 最新ユーザー指示）
- ユーザー承認が新たに必要になったら、具体的な内容を一度だけ提示し、作業と継続予約を停止する。承認待ちの予約はPAUSEDにし、返答が来るまで状態確認・再質問を繰り返さない。
- 承認の返信後は、その範囲を再承認待ちにせず作業を再開する。通常開発の包括承認は維持する。以前の「質問中も独立作業を続行」は承認待ちには適用しない。
## 完成までの包括承認（2026-09-16 最新追加指示）
- ユーザーは「全ての作業に置いて承認するから完成まで自動で進めてくれていい」「変な承認待ちで確認ばかり細かくするのだけ辞めて」と明示。完成に必要な作業を包括承認として扱い、実装・検査・PR・通常マージ・承認済みSTAGING反映を細分化して再確認しない。
- finalizeStagedUpload単独のlkc-staging-deploy保護環境承認、専用会社限定acceptance配備、承認済み2ファイルの転送試験、paused復帰配備は個別にも明示承認済み。
- 自動承認審査の拒否時は、その具体的操作に対する既存の承認根拠を確認する。実際に新しい本人操作・追加承認が不可避な場合だけ、承認待ち停止ルールを適用する。
- 9/16の包括承認に基づく次の復旧単位は応募確定・再提出5関数と対応Cloud Runサービス。PR146の通常CI/マージと保護環境を経由し、転送pausedを維持する。実業務原本・実送信・本番操作は含まない。

- 9/16の完成までの包括承認に基づく次の復旧単位は、経費確認3関数・元シフトリンク取得・印刷済み登録・案件取消・案件複製の7 HTTP関数。既存mainの認証/会社分離/業務保護を維持し、正式CI/通常マージ/保護環境経由でSTAGINGだけへ反映する。配備確認では実業務APIを認証付きで呼ばず、転送pausedを維持する。
