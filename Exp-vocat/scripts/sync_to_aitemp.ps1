# Sync this repo (local wins) into https://github.com/liwuaa/AITemp Exp-vocat/
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync_to_aitemp.ps1
#   git sync-aitemp

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/liwuaa/AITemp.git"
$RemotePrefix = "Exp-vocat"
$Src = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Work = Join-Path $env:TEMP "AITemp-sync"
function Invoke-GitNet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    git @GitArgs
    if ($LASTEXITCODE -eq 0) { return }
    git -c http.proxy=http://127.0.0.1:10809 -c https.proxy=http://127.0.0.1:10809 -c http.version=HTTP/1.1 @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed ($LASTEXITCODE)" }
}

Write-Host "Source : $Src"
Write-Host "Target : $RepoUrl/$RemotePrefix (local wins)"

if (Test-Path (Join-Path $Work ".git")) {
    Push-Location $Work
    Invoke-GitNet fetch origin
    git checkout main
    git reset --hard origin/main
    Pop-Location
} else {
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
    Invoke-GitNet clone $RepoUrl $Work
}

$Dst = Join-Path $Work $RemotePrefix
if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
New-Item -ItemType Directory -Path $Dst -Force | Out-Null

# Mirror working tree; keep AITemp/.git only.
$excludeDirs = @(".git", "build", "managed_components", ".vscode", ".devcontainer", ".cache", "releases", "tmp")
$excludeFiles = @("sdkconfig", "sdkconfig.old", "dependencies.lock", ".env")
$xd = ($excludeDirs | ForEach-Object { "/XD"; $_ })
$xf = ($excludeFiles | ForEach-Object { "/XF"; $_ })
& robocopy $Src $Dst /E @xd @xf /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
# robocopy: 0/1 = success
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

Push-Location $Work
try {
    git add -- $RemotePrefix
    $pending = git status --porcelain -- $RemotePrefix
    if (-not $pending) {
        Write-Host "Already up to date with GitHub."
        return
    }

    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    git commit --no-verify -m "Sync Exp-vocat from local ($stamp)"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

    Invoke-GitNet push origin main
    Write-Host "Pushed to $RepoUrl ($RemotePrefix)."
} finally {
    Pop-Location
}
