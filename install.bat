@echo off
echo ========================================
echo    KIOSK DE FOTOS - INSTALACAO
echo ========================================
echo.

echo [1/4] Verificando Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERRO: Node.js nao encontrado!
    echo Por favor, instale Node.js 16+ de: https://nodejs.org
    pause
    exit /b 1
)
echo Node.js encontrado: 
node --version

echo.
echo [2/4] Instalando dependencias principais...
npm install
if %errorlevel% neq 0 (
    echo ERRO: Falha ao instalar dependencias principais
    pause
    exit /b 1
)

echo.
echo [3/4] Instalando dependencias do servidor...
cd src\server
npm install
if %errorlevel% neq 0 (
    echo ERRO: Falha ao instalar dependencias do servidor
    pause
    exit /b 1
)
cd ..\..

echo.
echo [4/4] Verificando configuracoes...
if not exist "config\settings.json" (
    echo AVISO: Arquivo config\settings.json nao encontrado
    echo O sistema criara configuracoes padrao na primeira execucao
)

if not exist "config\image_settings.json" (
    echo AVISO: Configure o caminho das imagens em config\image_settings.json
)

echo.
echo ========================================
echo    INSTALACAO CONCLUIDA COM SUCESSO!
echo ========================================
echo.
echo Para executar o sistema:
echo   npm start          - Modo normal
echo   npm run dev        - Modo desenvolvimento  
echo   npm run kiosk      - Modo kiosk (tela cheia)
echo   npm run server     - Apenas servidor
echo.
echo Para configurar:
echo   1. Edite config\image_settings.json com o caminho das suas imagens
echo   2. Acesse http://localhost:5000/login (senha: 869407)
echo   3. Configure suas impressoras no painel admin
echo.
echo Pressione qualquer tecla para continuar...
pause >nul