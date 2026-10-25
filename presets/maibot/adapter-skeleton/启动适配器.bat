@echo off
rem 娅娅桌宠适配器一键启动（需先完成 README.md 里的安装步骤）
chcp 65001 >nul
cd /d %~dp0
if exist ".venv\Scripts\python.exe" (
  .venv\Scripts\python.exe deskpet_adapter.py
) else (
  python deskpet_adapter.py
)
echo.
echo 适配器已退出。若是报错，请把上面的日志截图反馈。
pause
