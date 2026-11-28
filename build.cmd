@echo off
setlocal
title LLMChat - Build and update
rem Use build.cmd -NoLaunch to update without reopening the application.

:build
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" %*
) else (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" %*
)
set "buildResult=%errorlevel%"
echo.
choice /C 12 /N /M "[1] Rebuild  [2] Exit: "
if errorlevel 2 goto done
if errorlevel 1 goto build

:done
exit /b %buildResult%
