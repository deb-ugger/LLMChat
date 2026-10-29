@echo off
setlocal
if not exist "%~dp0..\build.cmd" (
  echo Build requires the LLMChat source checkout in the parent directory.
  echo Please keep this portable folder inside the source checkout.
  pause
  exit /b 1
)
call "%~dp0..\build.cmd" %*
exit /b %errorlevel%
