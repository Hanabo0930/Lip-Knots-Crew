@echo off
chcp 65001 >nul
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 が見つかりません。README_アプリを見る.md を確認してください。
  pause
  exit /b 1
)
node scripts\preview-demo.mjs --open
if errorlevel 1 pause
popd
