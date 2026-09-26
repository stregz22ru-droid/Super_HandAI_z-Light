@echo off
rem === Super_HandAI_z run.cmd с preflight-проверкой окружения ===
setlocal enabledelayedexpansion
set NODE_DIR=C:\Utilit\node
set ROOT=C:\Super_HandAI_z
set PATH=%NODE_DIR%;%PATH%

set FAIL=0

rem -- Node v20.x --
if not exist "%NODE_DIR%\node.exe" (
  echo [FAIL] node.exe не найден в %NODE_DIR%
  set FAIL=1
) else (
  for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
  echo [ok] node !NODEV!
  echo !NODEV!| findstr /b "v20." >nul || (
    echo [FAIL] требуется Node v20.x, обнаружено !NODEV!
    set FAIL=1
  )
)

rem -- Шеллы --
if exist "%ROOT%\runtime\pwsh\pwsh.exe" (echo [ok] pwsh) else (echo [FAIL] runtime\pwsh\pwsh.exe & set FAIL=1)
if exist "%ROOT%\runtime\git\bin\bash.exe" (echo [ok] bash) else (echo [FAIL] runtime\git\bin\bash.exe & set FAIL=1)
if exist "%ROOT%\runtime\git\cmd\git.exe" (echo [ok] git) else (echo [FAIL] runtime\git\cmd\git.exe & set FAIL=1)

rem -- Нативный PTY-модуль --
if exist "%ROOT%\agent\node_modules\@lydell\node-pty" (echo [ok] node-pty) else (echo [FAIL] agent\node_modules\@lydell\node-pty — запусти install.cmd & set FAIL=1)

rem -- dist --
if exist "%ROOT%\agent\dist\main.js" (echo [ok] dist) else (echo [FAIL] agent\dist\main.js — пересобери: npx tsc & set FAIL=1)

rem -- Статика UI --
if exist "%ROOT%\agent\public\vendor\xterm.js" (echo [ok] xterm) else (echo [FAIL] agent\public\vendor\xterm.js & set FAIL=1)

rem -- Порт 8787 --
netstat -ano | findstr ":8787 .*LISTENING" >nul
if !errorlevel! equ 0 (
  echo [WARN] порт 8787 уже занят — вероятно, агент уже запущен
)

if !FAIL! equ 1 (
  echo.
  echo === ПРЕДЗАПУСКОВЫЕ ПРОВЕРКИ ПРОВАЛЕНЫ — старт отменён ===
  pause
  exit /b 1
)

echo.
echo === preflight ok, стартую ===
node "%ROOT%\agent\dist\main.js"
pause