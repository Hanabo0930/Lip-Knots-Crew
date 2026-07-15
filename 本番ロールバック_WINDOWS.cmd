@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set "NODE_MAJOR=%%V"
if not "%NODE_MAJOR%"=="22" (
  echo [BLOCKED] Node 22 が必要です。現在: %NODE_MAJOR%
  pause
  exit /b 1
)
where firebase >nul 2>nul
if errorlevel 1 (
  echo [BLOCKED] Firebase CLI が見つかりません。
  pause
  exit /b 1
)
if not exist "release-evidence\production\rollback-trigger.json" (
  echo [BLOCKED] 受入失敗のrollback-trigger.jsonがありません。
  echo 予防的な手動rollbackはこのファイルから実行できません。
  pause
  exit /b 1
)
if not exist "config\production-rollback-request.json" (
  copy /Y "config-samples\production-rollback-request.example.json" "config\production-rollback-request.json" >nul
  echo known-good Release、bundle、Staff/Admin Hosting復旧元を実値へ変更してください。
  notepad "config\production-rollback-request.json"
  pause
  exit /b 0
)
if not exist "config\production-rollback-approval.json" goto PREPARE

node scripts\production-rollback.mjs --validate-approval
if errorlevel 1 (
  echo rollback承認JSONを修正し、15分期限と6確認を更新してください。
  notepad "config\production-rollback-approval.json"
  pause
  exit /b 1
)
set /p "ROLLBACK_FINGERPRINT=64文字 ROLLBACK FINGERPRINT を貼り付けてください: "
set /p "ROLLBACK_TYPED=最終確認として ROLLBACK_PRODUCTION と入力してください: "
if not "%ROLLBACK_TYPED%"=="ROLLBACK_PRODUCTION" exit /b 1
choice /C YN /N /M "緊急停止を維持したまま4段階rollbackを実行しますか？ [Y/N]: "
if errorlevel 2 exit /b 0
choice /C YN /N /M "最終確認です。本番を既知正常版へ戻しますか？ [Y/N]: "
if errorlevel 2 exit /b 0
node scripts\production-rollback.mjs --apply --confirm "%ROLLBACK_FINGERPRINT%" --typed "%ROLLBACK_TYPED%"
if errorlevel 1 goto FAILED
echo [SUCCEEDED] 緊急停止は維持してください。本番復旧受入_WINDOWS.cmdを3回実行してください。
pause
exit /b 0

:PREPARE
node scripts\production-rollback.mjs --prepare
if errorlevel 1 goto FAILED
notepad "config\production-rollback-approval.json"
echo 別承認者が承認JSONを完成させ、15分以内に再実行してください。
pause
exit /b 0

:FAILED
echo [STOPPED / LOCKED] 後続stageは実行していません。緊急停止を解除しないでください。
pause
exit /b 1
