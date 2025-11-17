@echo off
setlocal
cd /d %~dp0\..

echo Encerrando processos...
taskkill /IM "Kiosk de Fotos.exe" /F >nul 2>&1
taskkill /IM electron.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1

echo Limpando build...
if exist build\win-unpacked rmdir /S /Q build\win-unpacked
echo OK.

endlocal