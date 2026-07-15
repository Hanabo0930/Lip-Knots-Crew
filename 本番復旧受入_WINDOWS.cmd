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
  pause
  exit /b 1
)
if not exist "release-evidence\production\rollback-result.json" (
  echo [BLOCKED] 成功済みrollback-result.jsonがありません。
  pause
  exit /b 1
)

node scripts\run-production-acceptance.mjs --run --after-rollback
if errorlevel 1 (
  echo.
  echo [FAILED / LOCKED] 緊急停止を解除しないでください。
  pause
  exit /b 1
)
echo.
echo 復旧受入が3/3になるまで、表示されたnext時刻以降に再実行してください。
echo 3/3後も自動では緊急停止を解除しません。責任者の承認を記録してください。
pause
exit /b 0
