@echo off
rem Launch Denia desktop pet (Yaya). Window close = tray; exit from tray menu.
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" "."
exit
