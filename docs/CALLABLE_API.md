# Callable API

## bootstrapSession

認証済みユーザーを、登録済みスタッフまたは管理者へ紐づけます。

### 入力
なし

### 出力
- role
- companyId
- staffId（スタッフのみ）
- refreshToken

---

## applyToJob

先着応募を確定します。

### 入力
```json
{
  "jobId": "job_123",
  "requestId": "画面操作ごとのUUID"
}
```

### 保証
- 案件が募集中
- 担当者が未確定
- 募集停止・キャンセルでない
- 同日に有効シフトがない
- 同じrequestIdの二重送信を防止

---

## submitPreContact

体温と到着予定時刻を送信します。

### 入力
```json
{
  "jobId": "job_123",
  "temperature": 36.2,
  "arrivalTime": "9:30"
}
```

---

## createUploadSession

画像・PDFのアップロード先を発行します。

### 入力
```json
{
  "jobId": "job_123",
  "type": "report",
  "files": [
    {
      "originalName": "IMG_0001.JPG",
      "contentType": "image/jpeg",
      "size": 1234567
    }
  ]
}
```

### 出力
- submissionId
- fileId
- storagePath

クライアントはFirebase Storageへ再開可能アップロードを行い、完了後にFunctionsがGoogle Driveへ移します。

---

## adminCancelJob

管理者が案件をキャンセルします。

### 入力
```json
{
  "jobId": "job_123",
  "reason": "メーカー都合によりキャンセル"
}
```

## v1.1 追加

### previewSheetRowCreation
管理者専用。スプシを変更せず、新規行追加の事前検査を行います。

入力:
- `dateKey`
- `rows`
- または `groupId`

出力:
- 対象月タブ
- 雛形行
- 追加予定行
- 数式検査
- 入力規則検査
- 警告・エラー

### getPilotReadiness
管理者専用。本番導入に必要な設定と停止キューを確認します。

### processSheetRowCreation
Firestoreトリガー。`sheetRowCreateQueue` のpendingを処理します。

### retrySheetRowCreation
5分ごと。一時エラーのキューを再試行します。

## v1.2 追加

### inspectSetupWizard
管理者専用。シフト表・スタッフ表を読取専用で検査し、全機能OFFの設定下書きを返します。

### saveSetupWizardDraft
管理者専用。検査済みの設定を `setupWizardDrafts/{companyId}` へ保存します。実設定は変更しません。

### getSetupWizardDraft
管理者専用。保存済みの設定下書きを取得します。

### previewMonthSheetCreation
管理者専用。新しい月タブの複製元、初期化列、数式列、作成条件を読取専用で確認します。

### createMonthSheetSafe
管理者専用。三重ロックと検証コピー承認が揃った場合だけ新月タブを作成します。

### getMonthCreationHistory
管理者専用。新月タブ作成履歴を取得します。

## v3.2 追加

### exportProductionApprovalPackage

staging管理者専用。社長承認済み公開審査を再判定し、対象production Project固定・30分限定のEd25519署名JSONを発行します。

入力: `stagedRolloutId`

### importProductionApprovalPackage

production管理者専用。署名、鍵ID、Project分離、企業ID、公開ゲートfingerprint、復元演習fingerprint、時刻を検証し、一度だけ受理します。

入力: `packageText`

### enableProductionRelease

production管理者専用。受理済みで未使用・期限内の`approvalPackageId`を、社長承認者とは別メールの管理者が一度だけ有効化します。

v3.3では、同じRelease・署名パッケージに紐づく当日指揮盤が`ready`・`GO`・`preflight`であり、現在時刻がT±5分以内であることも必須です。

## v3.3 追加

### getProductionCutoverStatus

管理者専用。企業の進行中または最新の本番切替指揮盤、7 checkpoint、現在判定、証跡、連続正常runを返します。

### createProductionCutover

production管理者専用。Releaseと切替予定時刻を指定し、T−60からT＋24時間の指揮盤を開始します。

入力: `releaseId`, `windowStartIso`

### saveProductionCutoverReadiness

production管理者専用。8項目の手動準備確認と3件以上の証跡を保存します。署名承認はサーバーが自動確認します。

### recordProductionCutoverObservation

production管理者専用。本番有効化後の認証、Functions、p95、スプシ、通知、queue、smoke、差異、重大障害、監視probeと2件以上の証跡を記録します。

### activateProductionCutoverRollback

production管理者専用。自動判定が`ROLLBACK_REQUIRED`の場合だけ、全体停止を不可逆にロックして切戻しを開始します。

### completeProductionCutover

production管理者専用。T＋24時間と連続正常12runを満たし、本番が正常稼働中の場合だけ完了固定します。

### cancelProductionCutover

production管理者専用。本番有効化前の指揮盤だけを理由付きで中止します。

## v3.4 追加

### getProductionSloDashboard

管理者専用。SLO基準、最新評価、1h・6h・24h・30d窓、エラーバジェット、進行中インシデント、直近10件を返します。

### saveProductionSloPolicy

production管理者専用。進行中インシデントがない場合だけ、可用性・成功率・p95・queue・監視鮮度・復旧連続回数を更新します。

### recordProductionSloObservation

production管理者専用。本番有効化済みReleaseへ認証、Functions、スプシ、通知、p95、queue、差異、重大停止、監視probeと証跡2件以上を記録します。時間bucket、SLO、SEV、インシデントを自動更新します。

### acknowledgeProductionIncident

production管理者専用。進行中インシデントへ担当者名と10文字以上の初動メモを固定します。

### resolveProductionIncident

production管理者専用。新しい正常観測が規定回数続き`recovery_pending`となった場合だけ、原因・復旧・再発防止を各20文字以上、証跡2件以上で解決固定します。
