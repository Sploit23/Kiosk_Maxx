@echo off
title Kiosk de Fotos - Sistema de Impressao
echo ========================================
echo    KIOSK DE FOTOS - INICIANDO SISTEMA
echo ========================================
echo.

echo Verificando dependencias...
if not exist "node_modules" (
    echo ERRO: Dependencias nao instaladas!
    echo Execute install.bat primeiro
    pause
    exit /b 1
)

echo Verificando configuracoes...
if not exist "config\settings.json" (
    echo AVISO: Configuracoes nao encontradas
    echo O sistema criara configuracoes padrao
)

echo.
echo Escolha o modo de execucao:
echo [1] Modo Normal (Aplicacao Desktop)
echo [2] Modo Desenvolvimento (com logs)
echo [3] Modo Kiosk (Tela Cheia)
echo [4] Apenas Servidor (sem interface)
echo [5] Sair
echo.
set /p choice="Digite sua opcao (1-5): "

if "%choice%"=="1" (
    echo Iniciando em modo normal...
    npm start
) else if "%choice%"=="2" (
    echo Iniciando em modo desenvolvimento...
    npm run dev
) else if "%choice%"=="3" (
    echo Iniciando em modo kiosk...
    npm run kiosk
) else if "%choice%"=="4" (
    echo Iniciando apenas servidor...
    npm run server
) else if "%choice%"=="5" (
    echo Saindo...
    exit /b 0
) else (
    echo Opcao invalida!
    pause
    goto :start
)

echo.
echo Sistema encerrado.
pause