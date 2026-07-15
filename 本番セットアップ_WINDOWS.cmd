@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [STOP] Node.js 22 が必要です。
  pause
  exit /b 1
)

for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%V
if not "%NODE_MAJOR%"=="22" (
  echo [STOP] Node.js 22 で実行してください。現在: Node %NODE_MAJOR%
  pause
  exit /b 1
)

if not exist "config" mkdir "config"
if not exist "config\production-setup.json" (
  copy /Y "config-samples\production-setup.example.json" "config\production-setup.json" >nul
  echo [1/3] production-setup.json を作成しました。
  echo 開いたJSONの YOUR_ を実値へ変更し、保存後にもう一度このファイルを実行してください。
  start "" notepad "config\production-setup.json"
  pause
  exit /b 0
)

echo [1/3] 本番設定を安全検査します。
node scripts\setup-production.mjs --config config\production-setup.json
if errorlevel 1 (
  echo [STOP] 上の項目を修正してから再実行してください。
  pause
  exit /b 1
)

choice /C YN /N /M "[2/3] 検査済みの本番設定10ファイルを生成しますか? [Y/N] "
if errorlevel 2 exit /b 0
node scripts\setup-production.mjs --config config\production-setup.json --write
if errorlevel 1 (
  echo [STOP] 既存設定は上書きしていません。
  pause
  exit /b 1
)

echo [3/3] デプロイ前の非破壊診断を実行します。
node scripts\production-deploy-readiness.mjs --config config\production-deploy.json
echo.
echo このウィザードはFirebaseデプロイを実行していません。
pause
