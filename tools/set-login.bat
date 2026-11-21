@echo off
chcp 65001 >nul
setlocal

rem Double-click entry: add the "login check-in" e-mail and password to
rem accounts that are already signed in. Kept ASCII because cmd misparses
rem UTF-8 in batch files; node prints the Chinese text.
rem
rem Password input is hidden, stays in this process memory only, and is
rem verified by a real login before anything is written.

cd /d "%~dp0.."

rem No arguments: ask about every account that still has no password.
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--all"

node tools\set-login.mjs %ARGS%
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" goto ok
echo Something went wrong - copy the text above and send it to the assistant.
goto end
:ok
echo Restart Magpie so the change takes effect.
:end
echo.
pause
