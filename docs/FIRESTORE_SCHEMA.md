# Firestore主要コレクション

## emailIndex/{emailHash}
- companyId
- staffId
- active
- email

## staffProfiles/{staffId}
- companyId
- displayName
- emailAddresses[]
- phone
- prefecture
- nearestStation
- active
- rank

## jobs/{jobId}
- companyId
- workDate
- dateKey
- clientName
- makerName
- menuName
- storeName
- storeAddress
- storeNearestStation
- workTime
- materialStatus
- basePay
- allowances[]
- status: open | assigned | stopped | cancelled | completed
- assignedStaffId
- assignedStaffName
- sheetRef

## staffDayLocks/{lockId}
- companyId
- staffId
- dateKey
- jobId
- active

## tasks/{taskId}
- companyId
- staffId
- jobId
- type
- dueAt
- completed

## submissions/{submissionId}
- companyId
- staffId
- jobId
- type: report | sales_floor
- status
- totalFiles
- firstCompletedAt

## sheetSyncQueue/{queueId}
- companyId
- jobId
- updates
- status
- attempts

## notificationQueue/{queueId}
- companyId
- targetUid
- title
- body
- route
- status


## sheetImportConfigs/{companyId}
- enabled
- scheduleEnabled
- spreadsheetId
- monthlySheetPattern
- importFrom
- readRangeEndColumn
- columns
- configVersion

## sheetImportRuns/{runId}
- companyId
- mode
- status
- totals
- sheets
- warnings
- startedAt
- completedAt

## syncLocks/{lockId}
- companyId
- token
- acquiredAt
- leaseUntil

## jobs/{jobId} 追加項目
- caseId
- sourceIdentityKey
- identityFingerprint
- sourceOccurrence
- publishable
- assignmentUnresolved
- financials
- source
- sync


## staffImportConfigs/{companyId}
- enabled
- scheduleEnabled
- spreadsheetId
- activeSheets
- excludedSheets
- sheetAreas
- markMissingInactive
- revokeRemovedEmailSessions
- columns

## staffImportRuns/{runId}
- companyId
- status
- totals
- sheets
- warnings
- startedAt
- completedAt

## staffProfiles/{staffId} 追加項目
- normalizedName
- emails
- primaryEmail
- emailCount
- emailConflicts
- invalidEmails
- phone
- homePrefecture
- nearestStation
- birthDateRaw
- areaLabels
- active
- sourceMissing
- sourceRefs
- profileConflicts
- authUids
- lastLoginAt

## emailIndex/{sha256(normalizedEmail)}
- companyId
- staffId
- email
- active
- updatedAt

## authIdentities/{firebaseUid}
- companyId
- staffId
- email
- emailHash
- active
- lastLoginAt
- revokedAt


## loginGatewayTokens/{tokenHash}
- companyId
- staffId
- emailHash
- actionLink
- active
- expiresAt
- createdAt
- openedAt
- openCount

## loginInviteBatches/{batchId}
- companyId
- actorUid
- staffIds
- subject
- introText
- status
- successStaff
- failedStaff
- results

## loginInviteDeliveries/{deliveryId}
- companyId
- staffId
- email
- emailHash
- subject
- status
- gmailMessageId
- sentAt
- errorMessage

## deviceSessions/{sessionId}
- companyId
- staffId
- uid
- deviceId
- label
- platform
- userAgent
- active
- createdAt
- lastSeenAt
- revokedAt
- revokeReason

## pushTokens/{tokenHash}
- companyId
- uid
- role
- staffId
- token
- deviceSessionId
- permission
- active
- platform
- userAgent
- lastSeenAt

## notificationQueue/{queueId}
- companyId
- targetStaffId / targetRole / targetUid
- title
- body
- route
- category
- dedupeKey
- status
- deliverAt
- quietDeferred
- attempts
- successCount
- failureCount

## notificationSettings/{companyId}
- enabled
- preContactThreeDaysHour
- importantAnnouncementHour
- printReminderDays
- quietStartHour
- quietEndHour
- staffNotifications
- adminNotifications

## announcementReceipts/{announcementId_staffId}
- companyId
- announcementId
- staffId
- confirmedAt


## jobs/{jobId} v0.9追加項目
- financials.clientChargeAdditionsTotal
- cancellationReasonCategory
- cancellationReasonNote
- cancellationFinancialTreatment
- cancellationFinancialTreatmentLabel
- preCancellationStatus
- appOverride
- restoredAt
- restoredBy

## appOverride
- type: cancel / restore
- active
- createdAt

読取同期がスプシの古い状態でアプリ操作を戻さないための一時保護です。


## companyFeatureSettings/{companyId}
- adminJobCreationSourceReady

## jobGroups/{groupId}
- companyId
- jobIds
- slotCount
- duplicatedFromJobId
- publication

## jobs/{jobId} v1.0追加
- groupId
- slotNumber
- slotCount
- revision
- adminCreated
- publishable
- recruitmentStopped
- scheduledPublishAt
- publicationBlockedReason
- sourceReady
- clientChargeInputs
- staffPaymentInputs
- pendingSourceWrite
- pendingSourceFields

## exportLogs/{exportId}
- companyId
- actorUid
- type
- groupBy
- name
- from
- through
- includeCancelled
- rows
- createdAt

## sheetRowCreateQueue/{queueId}
- companyId
- groupId
- jobIds
- status
- attempts
- idempotencyKey
- sheetName
- startRow
- endRow
- verification
- errorType
- errorMessage
- retryAt
- createdAt
- completedAt

## sheetRowCreationIdempotency/{hash}
- companyId
- queueId
- status
- sheetName
- startRow
- endRow
- completedAt

## sheetRowManualInterventions/{interventionId}
- companyId
- queueId
- inserted
- errorMessage
- status
- createdAt

## jobs/{jobId} v1.1追加
- requestedPublicationMode
- requestedPublishAt
- sourceCreationStatus
- sourceCreationError
- sourceCreatedAt

## setupWizardInspections/{inspectionId}
- companyId
- actorUid
- shiftSpreadsheetId
- staffSpreadsheetId
- shiftHeader
- staffHeader
- formulaColumns
- validationColumns
- monthTabs
- draft
- warnings
- expiresAt
- createdAt

## setupWizardDrafts/{companyId}
- companyId
- inspectionId
- draft
- warnings
- allEnabled
- status
- savedBy
- savedAt

## monthSheetCreationRuns/{runId}
- companyId
- actorUid
- spreadsheetId
- sourceMonth
- targetMonth
- createdSheetId
- clearRanges
- verification
- status
- errorMessage
- startedAt
- completedAt

## monthSheetManualInterventions/{interventionId}
- companyId
- runId
- spreadsheetId
- targetMonth
- createdSheetId
- errorMessage
- rollbackError
- status
- createdAt
# v3.2 本番承認パッケージ

- `productionApprovalPackageExports/{packageId}`: stagingで発行した署名JSON、鍵ID、対象Project、公開・復元fingerprint、30分期限
- `productionApprovalPackages/{packageId}`: productionで検証・受理した一回限りの承認、`ready_to_enable`→`used`または`expired`
- `productionControls/{companyId}.pendingApprovalPackageId`: 現在の有効化待ちパッケージ
- `productionReleaseAuthorizations/{id}.approvalPackageId`: 最終有効化に使用した署名パッケージ

# v3.3 本番切替当日指揮盤

- `productionCutoverControls/{companyId}`: 企業ごとの進行中指揮盤ID
- `productionCutoverRuns/{runId}`: Release、切替時刻、準備確認、閾値、7 checkpoint、最新観測、連続正常run、現在判定、fingerprint、完了・中止・切戻し状態
- `productionCutoverObservations/{observationId}`: 認証、Functions、p95、スプシ、通知、queue、smoke、データ差異、重大障害、監視probe、証跡、記録時判定
- `productionReleaseAuthorizations/{id}.cutoverRunId`: T±5分・GO・同一Release・同一署名パッケージで有効化した指揮盤
- `productionEmergencyEvents/{id}`: `ROLLBACK_REQUIRED`から開始した不可逆な全体停止・切戻し証跡

# v3.4 本番SLO・自動インシデント

- `productionSloPolicies/{companyId}`: 可用性、成功率、p95、queue、監視鮮度、復旧連続回数のSLO基準
- `productionSloObservations/{observationId}`: Releaseに紐づく本番観測値と証跡
- `productionSloHourBuckets/{companyId_hour}`: 30日ローリング評価用の時間集約値
- `productionSloSnapshots/{companyId}`: 1h・6h・24h・30d評価、エラーバジェット、SEV、signal、fingerprint
- `productionSloControls/{companyId}`: 企業ごとの進行中インシデントID
- `productionIncidents/{incidentId}`: SEV、最高SEV、状態、担当、復旧連続回数、原因、復旧、再発防止
- `productionIncidentEvents/{eventId}`: 自動起票、更新、上昇、正常観測、復旧確認、担当、解決の時系列証跡
