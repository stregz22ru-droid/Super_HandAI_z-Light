@echo off
set PATH=C:\Utilit\node;%PATH%
cd /d "%~dp0agent"
npm install
echo === ready ===
pause
