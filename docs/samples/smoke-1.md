# ЗАДАЧ: Smoke-ruk
# META
workdir: new:smoke-1
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. pwsh
RUN shell: pwsh
```pwsh
Write-Output hands-ok; exit 0
```
EXPECT exit=0
EXPECT stdout contains: hands-ok

## ШАГ 2. bash
RUN shell: bash
```bash
echo bash-ok
```
EXPECT exit=0
EXPECT stdout contains: bash-ok

## ШАГ 3. checkpoint
GIT commit: "smoke"