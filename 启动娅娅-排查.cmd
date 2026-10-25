@echo off
rem ============================================================
rem  Yaya desktop pet - diagnostic launcher
rem
rem  IMPORTANT: this file must stay pure ASCII.
rem  cmd.exe reads .cmd files byte by byte using the OEM code
rem  page (936 on this machine). A single non-ASCII character
rem  (for example Chinese text) is 3 bytes in UTF-8, which GBK
rem  splits into one double-byte char plus one stray byte, and
rem  the line gets broken into bogus commands.
rem  Keep every byte below 0x80 in this file.
rem ============================================================
cd /d "%~dp0"

set "EXE=node_modules\electron\dist\electron.exe"

echo ============================================
echo  Yaya desktop pet - starting
echo  folder : %CD%
echo ============================================

if not exist "%EXE%" goto :noexe
if not exist "electron\main.cjs" goto :badfolder

echo.
echo [INFO] Launching Electron now.
echo        The window may need several seconds while the MMD
echo        model and the physics engine load.
echo        Keep this console open until the tray icon appears.
echo --------------------------------------------------------
echo.

rem NOTE: no "start" here on purpose. "start" detaches the
rem process and swallows every error message.
"%EXE%" .
set "RC=%ERRORLEVEL%"

echo.
echo --------------------------------------------------------
echo [INFO] exit code : %RC%
echo.

if "%RC%"=="0" goto :ok

echo [FATAL] Electron did not start normally.
echo.
echo   -1073740791   0xC0000409   crash inside a native DLL,
echo                               often an antivirus hook or a
echo                               bad graphics driver
echo   -2147483645   0x80000003   EXCEPTION_BREAKPOINT, an
echo                               internal Electron check failed
echo          1                   app called app.quit, often a
echo                               second instance holding the lock
echo.
echo What to try, in order:
echo   1. Close every Electron process in Task Manager, retry.
echo   2. Antivirus may be blocking electron.exe. Add an
echo      exclusion for this whole folder, then retry.
echo   3. Run the GPU-off variant in the same folder.
echo   4. Install VC++ redistributable if missing:
echo      https://aka.ms/vs/17/release/vc_redist.x64.exe
echo.
pause
endlocal
exit /b 1

:ok
echo [OK] Electron exited normally, code 0.
echo      If no tray icon is visible, check the tray overflow.
echo.
pause
endlocal
exit /b 0

:noexe
echo.
echo [FATAL] electron.exe was not found:
echo           %CD%\%EXE%
echo.
echo   Dependencies are missing. Repair with:
echo     cd /d "%~dp0"
echo     npm install
echo.
echo   If node_modules\electron\dist is still missing, the
echo   150 MB binary download failed. Delete node_modules and
echo   run npm install again.
echo.
pause
endlocal
exit /b 1

:badfolder
echo.
echo [FATAL] electron\main.cjs was not found in:
echo           %CD%
echo   This launcher must stay in the project root folder.
echo.
pause
endlocal
exit /b 1
