# Super_HandAI_z Light - setup
Write-Host "============================================"
Write-Host " Super_HandAI_z Light - setup"
Write-Host "============================================"
Write-Host ""

Write-Host -NoNewline "Root folder [C:/Super_HandAI_z]: "
 $root = Read-Host
if ([string]::IsNullOrWhiteSpace($root)) { $root = "C:/Super_HandAI_z" }

 $root = $root.TrimEnd("/").TrimEnd("\")

Write-Host -NoNewline "Agent port [8787]: "
 $port = Read-Host
if ([string]::IsNullOrWhiteSpace($port)) { $port = "8787" }

Write-Host ""
Write-Host "=== creating config.json ==="
 $stateDir = Join-Path $root "data/state"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

 $cfgPath = Join-Path $stateDir "config.json"
 $config = [ordered]@{
  port = [int]$port
  workspaceRoot = "$root/workspace"
  shells = [ordered]@{
    pwsh = @{ cmd = "$root/runtime/pwsh/pwsh.exe"; args = @("-NoLogo", "-NoProfile", "-Command") }
    bash = @{ cmd = "$root/runtime/git/bin/bash.exe"; args = @("-c") }
    pwshFallback = @{ cmd = "powershell.exe"; args = @("-NoLogo", "-NoProfile", "-Command") }
    linuxBash = @{ cmd = "/bin/bash"; args = @("-c") }
  }
  stepTimeoutSec = 120
  maxOutputBytes = 1048576
}
 $config | ConvertTo-Json -Depth 5 | Out-File -FilePath $cfgPath -Encoding utf8

Write-Host "[ok] config created: $cfgPath"
Write-Host ""
Write-Host "=== done ==="
Write-Host "next: install.cmd then run.cmd"
Write-Host "token is STABLE: agent/data/state/agent.token"