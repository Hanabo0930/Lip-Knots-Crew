@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 is required.
  pause
  exit /b 1
)
if not exist "release-evidence\production\deployment-result.json" (
  echo [ERROR] release-evidence\production\deployment-result.json was not found.
  echo Run the approved production deployment first.
  pause
  exit /b 1
)
node scripts\create-production-evidence-sync-package.mjs --write --replace
if errorlevel 1 (
  echo [ERROR] Evidence validation failed. No sync package was created.
  pause
  exit /b 1
)
echo.
echo [OK] release-evidence\production\admin-sync-package.json
echo Upload this JSON from the Admin production evidence live console.
explorer /select,"%~dp0release-evidence\production\admin-sync-package.json"
pause
