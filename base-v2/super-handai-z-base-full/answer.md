# ЗАДАЧ: E2E smoke — создать test-autopilot.txt
# META
workdir: new:autopilot-e2e
mode: confirm
on_fail: stop
cycle: 1

## ШАГ 1. Записать маркерный файл в корень workdir
RUN shell: pwsh
```pwsh
Set-Content -Path 'test-autopilot.txt' -Value 'autopilot-e2e' -Encoding utf8
if (-not (Test-Path -LiteralPath 'test-autopilot.txt')) { Write-Output 'file missing'; exit 1 }
exit 0
```
EXPECT exit=0
EXPECT file exists:test-autopilot.txt