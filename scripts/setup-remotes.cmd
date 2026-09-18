@echo off
REM ============================================================
REM  QianSi - Dual Remote Setup (wrapper)
REM
REM  Purpose: bypass PowerShell execution policy
REM           (.ps1 files cannot run directly on this machine)
REM
REM  Usage:
REM    scripts\setup-remotes.cmd -GiteeUser NAME -GitHubUser NAME
REM    scripts\setup-remotes.cmd -GiteeUser NAME -GitHubUser NAME -DryRun
REM
REM  NOTE: This file is intentionally ASCII-only.
REM        cmd.exe reads .cmd in the OEM codepage (GBK on zh-CN),
REM        so non-ASCII characters here would break parsing.
REM ============================================================

setlocal
set "SCRIPT=%~dp0setup-remotes.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] Not found: %SCRIPT%
    endlocal & exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [FAILED] exit code %RC%
)

endlocal & exit /b %RC%
