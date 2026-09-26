# AGP-MVP smoke test (Windows / PowerShell 5.1+ compatible).
# 1) Start the gateway first:  start.bat
# 2) Then run in another console:
#    powershell -ExecutionPolicy Bypass -File test-agp.ps1
param([string]$Base = "http://127.0.0.1:8790")

$script:pass = 0
$script:fail = 0

function Test-Mark([string]$name, $actual, [string]$expected) {
  if ("$actual" -eq $expected) {
    $script:pass++
    Write-Host ("[OK]   {0}: {1}" -f $name, $actual)
  } else {
    $script:fail++
    Write-Host ("[FAIL] {0}: got '{1}', expected '{2}'" -f $name, $actual, $expected)
  }
}

Write-Host "AGP-MVP smoke test against $Base"
Write-Host ""

# Gateway must be up
try {
  $null = Invoke-RestMethod -Uri "$Base/audit/verify" -TimeoutSec 3
} catch {
  Write-Host "Gateway is NOT reachable at $Base. Run start.bat first."
  exit 2
}

# 1) plain /check -> ALLOW
$r1 = Invoke-RestMethod -Method Post -Uri "$Base/check" -ContentType "application/json" `
  -Body '{"eventId":"smoke-allow-1","agentId":"win-smoke","action":"read_file","target":"notes.txt"}'
Test-Mark "ALLOW (/check)" $r1.decision "ALLOW"

# 2) operation run + Remove-Item -Recurse -> DENY (ops-run-001)
$b2 = @{ agentId = "win-smoke"; operation = "run"; preview = "Remove-Item -Path C:/tmp/cache -Recurse -Force" } | ConvertTo-Json
$r2 = Invoke-RestMethod -Method Post -Uri "$Base/agent/check-operation" -ContentType "application/json" -Body $b2
Test-Mark "OP run + Remove-Item -Recurse" $r2.decision "DENY"

# 3) operation write outside workspace -> REVIEW (ops-ws-001)
$b3 = @{ agentId = "win-smoke"; operation = "write"; preview = "# report"; targetPath = "C:/Users/ops/Desktop/report.xlsx"; workspace = "C:/work/scenario" } | ConvertTo-Json
$r3 = Invoke-RestMethod -Method Post -Uri "$Base/agent/check-operation" -ContentType "application/json" -Body $b3
Test-Mark "OP write outside workspace" $r3.decision "REVIEW"

# 4) operation git push -> REVIEW (ops-git-001)
$b4 = @{ agentId = "win-smoke"; operation = "git"; preview = "git push origin main" } | ConvertTo-Json
$r4 = Invoke-RestMethod -Method Post -Uri "$Base/agent/check-operation" -ContentType "application/json" -Body $b4
Test-Mark "OP git push" $r4.decision "REVIEW"

# 5) audit chain intact
$v = Invoke-RestMethod -Uri "$Base/audit/verify"
Test-Mark "Audit chain" $v.ok "True"

Write-Host ""
if ($script:fail -eq 0) {
  Write-Host ("SMOKE: PASS ({0} markers)" -f $script:pass)
} else {
  Write-Host ("SMOKE: FAIL ({0} failed)" -f $script:fail)
  exit 1
}
