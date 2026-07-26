#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")
foreach ($candidate in @("C:\Program Files\nodejs", "G:\GITHUB")) {
    if (Test-Path (Join-Path $candidate "node.exe")) {
        $env:Path = "$candidate;$env:Path"
    }
}

Write-Host "========================================"
Write-Host " QQ Music + Xiaozhi MCP Start"
Write-Host "========================================"
Write-Host ""

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "[HINT] Created .env from .env.example. Fill MCP_ENDPOINT first."
        exit 1
    }
}

Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -eq 2) {
        Set-Item -Path "Env:$($parts[0].Trim())" -Value $parts[1].Trim()
    }
}

if (-not $env:MCP_ENDPOINT -or $env:MCP_ENDPOINT -match "请替换") {
    Write-Host "[ERROR] Please set a valid MCP_ENDPOINT in .env"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] node not found. Install Node.js 20+"
    exit 1
}

if (-not (Test-Path "node_modules\@sansenjian\qq-music-api")) {
    npm install
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    python -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install -U pip
    & .\.venv\Scripts\python.exe -m pip install -r "mcp\requirements.txt"
}

New-Item -ItemType Directory -Force -Path "logs","config" | Out-Null
$root = $PSScriptRoot
$env:QQ_MUSIC_API_CONFIG_DIR = Join-Path $root "config"
$env:USE_GLOBAL_COOKIE = "true"
$port = if ($env:PORT) { $env:PORT } else { "3200" }
$proxyPort = if ($env:MUSIC_PROXY_PORT) { $env:MUSIC_PROXY_PORT } else { "3210" }
$proxyHost = if ($env:MUSIC_PROXY_HOST) { $env:MUSIC_PROXY_HOST } else { "127.0.0.1" }

Write-Host "[INFO] QQ Music API   = http://localhost:$port"
Write-Host "[INFO] Music Proxy    = http://${proxyHost}:${proxyPort}/proxy/play"
Write-Host "[INFO] MCP Endpoint   = $($env:MCP_ENDPOINT)"
Write-Host ""

Write-Host "[LOGIN] Check QQ Music cookie / show QR if needed ..."
node ".\scripts\ensure-login.mjs"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] QQ Music login failed"
    exit 1
}

Write-Host "[START] QQ Music API ..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "set QQ_MUSIC_API_CONFIG_DIR=$($env:QQ_MUSIC_API_CONFIG_DIR)&& set USE_GLOBAL_COOKIE=true&& set PORT=$port&& node .\node_modules\@sansenjian\qq-music-api\dist\app.js" -WorkingDirectory $root

Write-Host "[START] Music Proxy Play ..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "set QQ_MUSIC_API_CONFIG_DIR=$($env:QQ_MUSIC_API_CONFIG_DIR)&& set USE_GLOBAL_COOKIE=true&& set MUSIC_PROXY_PORT=$proxyPort&& node .\mcp\proxy-play.mjs" -WorkingDirectory $root

Start-Sleep -Seconds 2

Write-Host "[START] Xiaozhi MCP Pipe ..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "set QQ_MUSIC_API_CONFIG_DIR=$($env:QQ_MUSIC_API_CONFIG_DIR)&& set USE_GLOBAL_COOKIE=true&& set MCP_ENDPOINT=$($env:MCP_ENDPOINT)&& set MUSIC_PROXY_HOST=$proxyHost&& set MUSIC_PROXY_PORT=$proxyPort&& .venv\Scripts\python.exe mcp\mcp_pipe.py" -WorkingDirectory $root

Write-Host ""
Write-Host "Started 3 windows. Wait for Successfully connected."
Write-Host "Stop with: .\stop.ps1"
