#Requires -Version 5.1
# Kill QQ Music API / Proxy / Xiaozhi MCP and leftover listeners.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "Stopping QQ Music API / Proxy / Xiaozhi MCP ..."

$patterns = @(
    'qq-music-api[/\\]dist[/\\]app\.js',
    'mcp[/\\]proxy-play\.mjs',
    'mcp[/\\]mcp_pipe\.py',
    'mcp[/\\]qq_music_local_mcp\.mjs',
    'scripts[/\\]ensure-login\.mjs'
)

function Get-MatchingProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = $_.CommandLine
            if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
            foreach ($p in $patterns) {
                if ($cmd -match $p) { return $true }
            }
            return $false
        }
}

function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return }
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

$killed = New-Object 'System.Collections.Generic.HashSet[int]'

# 1) Kill by command line (MCP has no listen port — must match this way)
Get-MatchingProcesses | ForEach-Object {
    $id = [int]$_.ProcessId
    if ($killed.Add($id)) {
        Write-Host ("  kill pid={0}  {1}" -f $id, $_.Name)
        Stop-Tree $id
    }
}

# 2) Kill listeners on API / proxy ports (orphans)
foreach ($port in 3200, 3210) {
    $found = $false
    try {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            ForEach-Object {
                $found = $true
                $id = [int]$_.OwningProcess
                if ($id -gt 0 -and $killed.Add($id)) {
                    Write-Host ("  kill listener :{0} pid={1}" -f $port, $id)
                    Stop-Tree $id
                }
            }
    } catch {
        $found = $false
    }
    if (-not $found) {
        netstat -ano 2>$null | ForEach-Object {
            $line = "$_"
            if ($line -match "[:\[]$port\s+" -and $line -match "LISTENING\s+(\d+)\s*$") {
                $id = [int]$Matches[1]
                if ($id -gt 0 -and $killed.Add($id)) {
                    Write-Host ("  kill listener :{0} pid={1}" -f $port, $id)
                    Stop-Tree $id
                }
            }
        }
    }
}

# 3) Close start.bat console hosts that still hold the window titles in CommandLine
foreach ($title in @('QQ-Music-API', 'QQ-Music-Proxy', 'Xiaozhi-MCP-Pipe')) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^(cmd|powershell|pwsh)\.exe$' -and
            $_.CommandLine -and
            ($_.CommandLine -like "*$title*" -or $_.CommandLine -match [regex]::Escape($PSScriptRoot))
        } |
        Where-Object {
            # Only cmd wrappers launched for our services
            $_.CommandLine -match 'qq-music-api|proxy-play|mcp_pipe|QQ-Music|Xiaozhi-MCP'
        } |
        ForEach-Object {
            $id = [int]$_.ProcessId
            if ($killed.Add($id)) {
                Write-Host ("  kill console pid={0}" -f $id)
                Stop-Tree $id
            }
        }
}

Start-Sleep -Milliseconds 500

# 4) Second pass for children missed on first kill
Get-MatchingProcesses | ForEach-Object {
    $id = [int]$_.ProcessId
    if ($killed.Add($id)) {
        Write-Host ("  kill(2) pid={0}  {1}" -f $id, $_.Name)
        Stop-Tree $id
    }
}

$left = @()
foreach ($port in 3200, 3210) {
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ($conns.Count -gt 0) {
            $left += ":$port(pid=$($conns[0].OwningProcess))"
        }
    } catch {}
}

if ($killed.Count -eq 0 -and $left.Count -eq 0) {
    Write-Host "Nothing to stop (already down)."
} elseif ($left.Count -gt 0) {
    Write-Host ("Done, but still listening: {0}" -f ($left -join ', '))
    exit 1
} else {
    Write-Host ("Done. Stopped {0} process tree(s)." -f $killed.Count)
}
