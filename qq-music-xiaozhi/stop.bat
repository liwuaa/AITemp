@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Stopping QQ Music API / Proxy / Xiaozhi MCP ...
echo.

REM Prefer PowerShell stop (matches command lines + ports + child trees).
where powershell >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
  if errorlevel 1 (
    echo [WARN] stop.ps1 reported an error, trying fallback ...
  ) else (
    goto :finish
  )
)

REM Fallback: kill by listen ports + known image command lines via WMIC
for %%P in (3200 3210) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    echo   kill listener :%%P pid=%%A
    taskkill /PID %%A /T /F >nul 2>nul
  )
)

for %%K in (
  "qq-music-api\dist\app.js"
  "mcp\proxy-play.mjs"
  "mcp\mcp_pipe.py"
  "mcp\qq_music_local_mcp.mjs"
) do (
  for /f "tokens=2 delims==;" %%A in ('wmic process where "CommandLine like '%%%~K%%'" get ProcessId /value 2^>nul ^| findstr "ProcessId"') do (
    echo   kill %%~K pid=%%A
    taskkill /PID %%A /T /F >nul 2>nul
  )
)

:finish
echo.
pause
