@echo off
setlocal
cd /d %~dp0\..

echo Encerrando processos...
taskkill /IM "Kiosk de Fotos.exe" /F >nul 2>&1
taskkill /IM electron.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1

echo Limpando build anterior...
if exist build\win-unpacked rmdir /S /Q build\win-unpacked
if not exist releases mkdir releases

echo Gerando build portatil...
node .\node_modules\electron-builder\out\cli\cli.js --win portable
if errorlevel 1 (
  echo ERRO: falha ao gerar build
  exit /b 1
)

echo Aguardando arquivos do build...
set /A _tries=0
:waitloop
if exist "build\win-unpacked\Kiosk de Fotos.exe" goto ready
set /A _tries+=1
if %_tries% GEQ 20 goto ready
timeout /t 1 /nobreak >nul
goto waitloop
:ready
echo Compactando para ZIP...
tar.exe -a -cf .\kiosk-portable.zip -C build\win-unpacked .
if errorlevel 1 (
  echo ERRO: falha ao compactar ZIP
  exit /b 1
)
echo ZIP criado: .\kiosk-portable.zip

echo Gerando ZIP em releases com timestamp...
set TS=
for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set _DATE=%%d%%b%%c
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set _TIME=%%a%%b
set TS=%_DATE%-%_TIME%
set TS=%TS: =%
if not exist releases mkdir releases
if not exist releases\%TS% mkdir releases\%TS%
if not exist .\kiosk-portable.zip (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path 'build\\win-unpacked\\*' -DestinationPath (Join-Path (Get-Location).Path 'kiosk-portable.zip') -Force"
)
copy /Y .\kiosk-portable.zip releases\%TS%\kiosk-portable.zip >nul
if errorlevel 1 (
  echo ERRO: falha ao copiar ZIP para releases
  exit /b 1
)
echo ZIP organizado: releases\%TS%\kiosk-portable.zip

echo Concluido.
endlocal