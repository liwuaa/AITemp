@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"
set "ROOT=%CD%"
set "QQ_MUSIC_API_CONFIG_DIR=%ROOT%\config"
set "USE_GLOBAL_COOKIE=true"
if "%PORT%"=="" set "PORT=3200"
if "%MUSIC_PROXY_PORT%"=="" set "MUSIC_PROXY_PORT=3210"
if "%MUSIC_PROXY_HOST%"=="" set "MUSIC_PROXY_HOST=127.0.0.1"

echo ========================================
echo  QQ Music + Xiaozhi MCP Start
echo ========================================
echo.

REM Refresh PATH
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
set "PATH=%MACHINE_PATH%;%USER_PATH%;%PATH%"
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "G:\GITHUB\node.exe" set "PATH=G:\GITHUB;%PATH%"

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [HINT] Created .env from .env.example. Fill MCP_ENDPOINT first.
    pause
    exit /b 1
  )
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%A"=="" set "%%A=%%B"
)

if "%MCP_ENDPOINT%"=="" (
  echo [ERROR] MCP_ENDPOINT is empty
  pause
  exit /b 1
)

echo %MCP_ENDPOINT% | findstr /C:"请替换" >nul
if not errorlevel 1 (
  echo [ERROR] Please set a real MCP_ENDPOINT in .env
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 20+
  pause
  exit /b 1
)

if not exist "node_modules\@sansenjian\qq-music-api" (
  echo [SETUP] npm install ...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo [SETUP] create venv and install python deps ...
  where python >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] python not found
    pause
    exit /b 1
  )
  python -m venv .venv
  call ".venv\Scripts\python.exe" -m pip install -U pip
  call ".venv\Scripts\python.exe" -m pip install -r "mcp\requirements.txt"
  if errorlevel 1 (
    echo [ERROR] pip install failed
    pause
    exit /b 1
  )
)

if not exist "logs" mkdir logs
if not exist "config" mkdir config

if "%MUSIC_PROXY_HOST%"=="" set "MUSIC_PROXY_HOST=127.0.0.1"
if "%MUSIC_PROXY_PORT%"=="" set "MUSIC_PROXY_PORT=3210"
if "%PORT%"=="" set "PORT=3200"

echo.
echo [INFO] QQ Music API   = http://localhost:%PORT%
echo [INFO] Music Proxy    = http://%MUSIC_PROXY_HOST%:%MUSIC_PROXY_PORT%/proxy/play
echo [INFO] MCP Endpoint   = %MCP_ENDPOINT%
echo [INFO] Keep MCP window open, or Xiaozhi will disconnect.
echo.

echo [LOGIN] Check QQ Music cookie / show QR if needed ...
node "%ROOT%\scripts\ensure-login.mjs"
if errorlevel 1 (
  echo [ERROR] QQ Music login failed
  pause
  exit /b 1
)
echo.

echo [START] QQ Music API ...
start "QQ-Music-API" /D "%ROOT%" cmd /k "set QQ_MUSIC_API_CONFIG_DIR=%QQ_MUSIC_API_CONFIG_DIR%&& set USE_GLOBAL_COOKIE=true&& set PORT=%PORT%&& node .\node_modules\@sansenjian\qq-music-api\dist\app.js"

echo [START] Music Proxy Play ...
start "QQ-Music-Proxy" /D "%ROOT%" cmd /k "set QQ_MUSIC_API_CONFIG_DIR=%QQ_MUSIC_API_CONFIG_DIR%&& set USE_GLOBAL_COOKIE=true&& set MUSIC_PROXY_PORT=%MUSIC_PROXY_PORT%&& node .\mcp\proxy-play.mjs"

ping -n 3 127.0.0.1 >nul

echo [START] Xiaozhi MCP Pipe (local cached MCP) ...
start "Xiaozhi-MCP-Pipe" /D "%ROOT%" cmd /k "set QQ_MUSIC_API_CONFIG_DIR=%QQ_MUSIC_API_CONFIG_DIR%&& set USE_GLOBAL_COOKIE=true&& set MCP_ENDPOINT=%MCP_ENDPOINT%&& set MUSIC_PROXY_HOST=%MUSIC_PROXY_HOST%&& set MUSIC_PROXY_PORT=%MUSIC_PROXY_PORT%&& .venv\Scripts\python.exe mcp\mcp_pipe.py"

echo.
echo Started 3 windows. Do NOT close them.
echo   1. QQ-Music-API
echo   2. QQ-Music-Proxy
echo   3. Xiaozhi-MCP-Pipe  (wait for Successfully connected)
echo.
echo Refresh MCP status on xiaozhi.me console.
echo Stop with stop.bat or close those windows.
echo.
pause
endlocal