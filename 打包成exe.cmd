@echo off
rem Build a double-clickable release folder with YaYa.exe inside.
rem Output: release folder under the project root.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime not found. Run "npm install" first.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"node_modules\electron\dist\electron.exe" "tools\make-exe.mjs"
set "ELECTRON_RUN_AS_NODE="
pause
