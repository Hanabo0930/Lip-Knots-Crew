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
if not exist "config\production-acceptance.json" (
  echo [BLOCKED] config\production-acceptance.json がありません。
  echo 先に本番セットアップを完了してください。
  pause
  exit /b 1
)
if not exist "release-evidence\production\deployment-result.json" (
  echo [BLOCKED] 成功済みdeployment-result.jsonがありません。
  pause
  exit /b 1
)

node scripts\run-production-acceptance.mjs --run
if errorlevel 1 (
  echo.
  echo [ROLLBACK REQUIRED] 後続の受入は停止しました。
  echo 本番ロールバック_WINDOWS.cmd を開いてください。
  pause
  exit /b 1
)
echo.
echo 合格回数が3/3になるまで、表示されたnext時刻以降にこのファイルを再実行してください。
pause
exit /b 0
