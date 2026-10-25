@echo off
rem Launch this character as an independent desktop pet (own tray/config/memory).
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" "." --pet=aimisi
exit
