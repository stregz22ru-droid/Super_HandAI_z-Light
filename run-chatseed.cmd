@echo off
title ChatSeed - exporter chats
set PATH=C:\Utilit\node;%PATH%
echo ============================================
echo  ChatSeed - exporter chats
echo ============================================
echo.
echo Primeri zapuska (posle etogo okna):
echo   node dist/cli.js --input file.txt --name my-chat --mode raw
echo   node dist/cli.js --input file.txt --name my-chat --mode compress --llm on
echo   node dist/cli.js --interactive
echo.
cd /d C:\Super_HandAI_z\tools\chatseed
cmd /k
