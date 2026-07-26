#Requires -Version 5.1
Set-Location $PSScriptRoot
Write-Host "Stopping QQ Music / Proxy / MCP ..."

Get-CimInstance Win32_Process |
    Where-Object {
        $_.CommandLine -match "qq-music-api\\dist\\app\.js" -or
        $_.CommandLine -match "mcp\\proxy-play\.mjs" -or
        $_.CommandLine -match "mcp\\mcp_pipe\.py" -or
        $_.CommandLine -match "mcp\\qq_music_local_mcp\.mjs"
    } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }

foreach ($port in 3200, 3210) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
        }
}

Write-Host "Done."
