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
  echo npm install -g firebase-tools を実行してから再開してください。
  pause
  exit /b 1
)

if not exist "config\production-deploy.json" (
  echo [BLOCKED] config\production-deploy.json がありません。
  echo 先に 本番セットアップ_WINDOWS.cmd を実行してください。
  pause
  exit /b 1
)

if not exist "config\production-deploy-approval.json" goto PREPARE

node scripts\deploy-production.mjs --validate-approval
if errorlevel 1 (
  echo.
  echo 承認JSONを修正し、承認時刻と30分以内の期限を更新してください。
  notepad "config\production-deploy-approval.json"
  pause
  exit /b 1
)

call npm run diagnose:production
if errorlevel 1 goto FAILED
call npm run build
if errorlevel 1 goto FAILED

echo.
set /p "PLAN_FINGERPRINT=画面の64文字 PLAN FINGERPRINT を貼り付けてください: "
choice /C YN /N /M "3段階の本番デプロイを実行しますか？ [Y/N]: "
if errorlevel 2 exit /b 0
node scripts\deploy-production.mjs --apply --confirm "%PLAN_FINGERPRINT%"
if errorlevel 1 goto FAILED
echo.
echo [SUCCEEDED] 証跡は release-evidence\production に保存されました。
pause
exit /b 0

:PREPARE
node scripts\deploy-production.mjs --prepare
if errorlevel 1 goto FAILED
notepad "config\production-deploy-approval.json"
echo.
echo 承認JSONを完成させて保存後、このファイルをもう一度実行してください。
pause
exit /b 0

:FAILED
echo.
echo [STOPPED] 後続stageは実行していません。release-evidence\production を確認してください。
pause
exit /b 1
