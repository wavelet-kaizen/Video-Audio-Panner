@echo off
setlocal
title Video Audio Panner - Create CRX
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pack-extension.ps1" %*
set "packExitCode=%ERRORLEVEL%"
echo.
pause
exit /b %packExitCode%
