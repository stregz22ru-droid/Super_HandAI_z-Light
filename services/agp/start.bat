@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo  AGP-MVP governance gateway   127.0.0.1:8790
echo  (portable node.exe included, no Node.js needed)
echo ================================================
echo.
node.exe dist\server.js
echo.
echo [AGP] Server exited. Exit code %errorlevel%.
pause
