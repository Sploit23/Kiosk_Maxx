@echo off
setlocal enabledelayedexpansion

echo ================================================
echo SCRIPT PARA CRIAR IMPRESSORA 15x20
echo ================================================
echo.

REM Verificar se esta executando como administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERRO: Execute este script como Administrador!
    echo Clique com botao direito no arquivo e selecione "Executar como administrador"
    echo.
    pause
    exit /b 1
)

echo Listando impressoras instaladas...
echo.

REM Listar impressoras usando wmic
echo Impressoras encontradas:
echo ------------------------
wmic printer get name /format:list | findstr "Name=" | findstr /v "Name=$" > temp_printers.txt

REM Verificar se encontrou impressoras
if not exist temp_printers.txt (
    echo Nenhuma impressora encontrada.
    pause
    exit /b 1
)

REM Mostrar impressoras numeradas
set count=0
for /f "tokens=2 delims==" %%a in (temp_printers.txt) do (
    set /a count+=1
    echo [!count!] %%a
    set "printer!count!=%%a"
)

if %count%==0 (
    echo Nenhuma impressora encontrada.
    del temp_printers.txt 2>nul
    pause
    exit /b 1
)

echo.
set /p "choice=Digite o numero da impressora desejada (1-%count%): "

REM Validar entrada
if "%choice%"=="" goto invalid
if %choice% LSS 1 goto invalid
if %choice% GTR %count% goto invalid

REM Obter nome da impressora selecionada
call set "selected_printer=%%printer%choice%%%"

echo.
echo Impressora selecionada: %selected_printer%
echo.

REM Criar apenas uma nova impressora (15x20)
set "printer2=%selected_printer% (15x20)"

echo Criando impressora...
echo ----------------------

REM Usar PowerShell para criar a impressora (mais confiavel)
powershell -Command "try { $originalPrinter = Get-Printer -Name '%selected_printer%' -ErrorAction Stop; $printer2Name = '%printer2%'; try { $existing2 = Get-Printer -Name $printer2Name -ErrorAction SilentlyContinue; if ($existing2) { Write-Host 'Impressora \"' $printer2Name '\" ja existe.' -ForegroundColor Yellow } else { Add-Printer -Name $printer2Name -DriverName $originalPrinter.DriverName -PortName $originalPrinter.PortName; Write-Host 'Criada: ' $printer2Name -ForegroundColor Green } } catch { Write-Host 'Erro ao criar ' $printer2Name ': ' $_.Exception.Message -ForegroundColor Red } } catch { Write-Host 'Erro: Impressora original nao encontrada.' -ForegroundColor Red }"

echo.
echo ================================================
echo OPERACAO CONCLUIDA!
echo ================================================
echo.
echo A seguinte impressora foi processada:
echo - Impressora principal (10x15): %selected_printer%
echo - Impressora criada (15x20): %printer2%
echo.
goto end

:invalid
echo Selecao invalida.
del temp_printers.txt 2>nul
pause
exit /b 1

:end
del temp_printers.txt 2>nul
echo Pressione qualquer tecla para sair...
pause >nul