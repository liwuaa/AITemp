@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Stopping QQ Music API / Proxy / Xiaozhi MCP ...

for /f "tokens=2 delims=," %%P in ('tasklist /FI "WINDOWTITLE eq QQ-Music-API*" /FO CSV /NH 2^>nul') do (
  taskkill /PID %%~P /T /F >nul 2>nul
)
for /f "tokens=2 delims=," %%P in ('tasklist /FI "WINDOWTITLE eq QQ-Music-Proxy*" /FO CSV /NH 2^>nul') do (
  taskkill /PID %%~P /T /F >nul 2>nul
)
for /f "tokens=2 delims=," %%P in ('tasklist /FI "WINDOWTITLE eq Xiaozhi-MCP-Pipe*" /FO CSV /NH 2^>nul') do (
  taskkill /PID %%~P /T /F >nul 2>nul
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3200" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3210" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)

echo Done.
pause