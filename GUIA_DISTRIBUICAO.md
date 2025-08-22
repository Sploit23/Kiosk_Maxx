# 📦 Guia de Distribuição do Photo Kiosk Desktop

## ⚠️ Situação Atual

Você tem uma pasta `dist/win-unpacked` que foi gerada por um build anterior, mas **NÃO é adequada para distribuição direta** aos clientes. Aqui está o que você precisa saber:

## 🚫 Por que `win-unpacked` NÃO é ideal para clientes?

1. **Muitos arquivos soltos** - São dezenas de arquivos e pastas
2. **Sem instalador** - Cliente precisa saber onde colocar os arquivos
3. **Sem auto-update** - Sistema de atualização não funciona corretamente
4. **Sem ícones no desktop** - Cliente não tem acesso fácil
5. **Sem registro no Windows** - Não aparece em "Programas e Recursos"

## ✅ Formatos Corretos para Distribuição

### 1. **NSIS Installer (.exe)** - RECOMENDADO
```
Photo-Kiosk-Desktop-Setup-2.0.0.exe
```
**Vantagens:**
- ✅ Instalação automática
- ✅ Cria ícone no desktop
- ✅ Registra no Windows
- ✅ Auto-update funciona perfeitamente
- ✅ Fácil para o cliente usar

### 2. **Portable (.zip)**
```
Photo-Kiosk-Desktop-2.0.0-win.zip
```
**Vantagens:**
- ✅ Não precisa instalar
- ✅ Pode rodar de pendrive
- ✅ Auto-update funciona
- ❌ Cliente precisa extrair manualmente

## 🔧 Como Gerar os Arquivos Corretos

### Problema Atual
O build está falhando porque há arquivos em uso. Siga estes passos:

### Passo 1: Fechar Tudo
```bash
# Feche TODOS os processos do Electron
# Feche o VS Code se estiver aberto
# Feche qualquer instância do aplicativo
```

### Passo 2: Limpar e Buildar
```bash
# Abra um novo terminal PowerShell
cd C:\Users\Acer\Desktop\kioskEletron

# Remova a pasta dist manualmente pelo Windows Explorer
# Ou force a remoção:
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue

# Execute o build
npm run build
```

### Passo 3: Verificar Resultado
Após o build bem-sucedido, você terá:
```
dist/
├── Photo-Kiosk-Desktop-Setup-2.0.0.exe    ← ESTE é para os clientes!
├── Photo-Kiosk-Desktop-2.0.0-win.zip      ← Versão portátil
├── latest.yml                              ← Para auto-update
└── win-unpacked/                           ← NÃO enviar para clientes
```

## 📋 O que Enviar para os Clientes

### ✅ Solução Implementada

### Correções Aplicadas (v2.0.0-Fixed)

1. **Problema de Caminhos Corrigido**: 
   - Implementada detecção automática se o app está empacotado (`app.isPackaged`)
   - Caminhos corrigidos para servidor, preload.js e ícone em produção
   - Usa `process.resourcesPath` para localizar arquivos quando empacotado

2. **Arquivos Corrigidos**:
   - `src/electron/main.js`: Lógica de detecção de empacotamento
   - Caminhos dinâmicos para servidor interno e recursos

### Versão Portátil Disponível

- **Localização**: `dist/win-unpacked/`
- **Executável**: `Photo Kiosk Desktop.exe`
- **Status**: Corrigido para funcionar quando empacotado

**Instruções para o cliente:**
1. Copiar a pasta `dist/win-unpacked/` completa para o computador do cliente
2. Executar `Photo Kiosk Desktop.exe` dentro da pasta
3. O aplicativo funcionará sem instalação
4. **Importante**: Manter todos os arquivos da pasta juntos

**Alternativa - Criar ZIP:**
```powershell
Compress-Archive -Path '.\dist\win-unpacked\*' -DestinationPath 'Photo-Kiosk-Desktop-v2.0.0-Fixed.zip'
```

### ⚠️ Instalador NSIS (Requer Privilégios)
**Arquivo:**
- `Photo-Kiosk-Desktop-Setup-2.0.0.exe`
- **Status:** Requer execução como administrador para build
- **Vantagens:** Instalação automática, ícones no menu, desinstalador

**Para gerar:**
1. Execute PowerShell como administrador
2. Execute `npm run build`
3. Siga o assistente de instalação

## 🔄 Sistema de Atualizações

### Para Instalador (.exe)
- ✅ **Funciona automaticamente**
- Cliente recebe notificações de atualização
- Download e instalação automáticos

### Para Versão Portátil (.zip)
- ✅ **Funciona automaticamente**
- Cliente recebe notificações de atualização
- Download automático, mas precisa extrair manualmente

## 🚀 Processo Completo de Distribuição

### 1. Build Local
```bash
npm run build
```

### 2. Testar Localmente
```bash
# Teste o instalador
.\dist\Photo-Kiosk-Desktop-Setup-2.0.0.exe

# Ou teste a versão portátil
# Extraia o .zip e execute o .exe dentro
```

### 3. Distribuir para Clientes
- Envie o arquivo `.exe` (instalador) por email, WhatsApp, etc.
- Ou hospede em um servidor/Google Drive

### 4. Para Atualizações Futuras
- Siga o processo do `GUIA_ATUALIZACAO.md`
- Clientes receberão automaticamente as atualizações

## 📁 Estrutura de Arquivos para Cliente

### Após Instalação (Instalador)
```
C:\Users\[Usuario]\AppData\Local\Programs\photo-kiosk-desktop\
├── Photo Kiosk Desktop.exe    ← Executável principal
├── resources\                 ← Recursos do app
├── locales\                   ← Idiomas
└── ... (outros arquivos)      ← Dependências
```

### Versão Portátil (Extraída)
```
C:\PhotoKiosk\                 ← Pasta escolhida pelo cliente
├── Photo Kiosk Desktop.exe    ← Executável principal
├── resources\                 ← Recursos do app
├── locales\                   ← Idiomas
└── ... (outros arquivos)      ← Dependências
```

## ⚡ Comandos Rápidos

```bash
# Build completo (gera instalador + portátil)
npm run build

# Build apenas para distribuição
npm run dist

# Build e publicar no GitHub (para auto-update)
npm run build-and-publish
```

## 🆘 Solução de Problemas

### Erro de Privilégios (Links Simbólicos)
Se você receber erro "O cliente não tem o privilégio necessário" durante o build:

**Causa:** O Windows requer privilégios de administrador para criar links simbólicos.

**Soluções:**
1. **Execute como Administrador:**
   - Abra o PowerShell como Administrador
   - Navegue até a pasta do projeto
   - Execute `npm run build`

2. **Use a Pasta Existente:**
   - A pasta `dist/win-unpacked` já contém uma versão funcional
   - Você pode compactar esta pasta em um ZIP para distribuição

3. **Alternativa Manual:**
   ```powershell
   # Comprimir a pasta existente
   Compress-Archive -Path "dist/win-unpacked" -DestinationPath "Photo-Kiosk-Desktop-v2.0.0.zip"
   ```

### "Arquivo em uso por outro processo"
1. Feche todas as instâncias do aplicativo
2. Feche VS Code
3. Abra Task Manager e mate processos "electron.exe"
4. Delete a pasta `dist` manualmente
5. Execute `npm run build` novamente

### "Build falha com erro de configuração"
- Verifique se o `package.json` está correto
- Execute `npm install` para reinstalar dependências

### "Cliente não consegue instalar"
- Peça para executar como administrador
- Verifique se o Windows Defender não está bloqueando
- Use a versão portátil como alternativa

---

## 🎯 RESUMO PARA VOCÊ

**❌ NÃO envie:** A pasta `dist/win-unpacked`

**✅ ENVIE:** O arquivo `Photo-Kiosk-Desktop-Setup-2.0.0.exe`

**📝 INSTRUÇÃO:** "Baixe e execute este arquivo como administrador"

**🔄 ATUALIZAÇÕES:** Automáticas via GitHub Releases

---

**🎉 Pronto! Agora você sabe exatamente como distribuir seu aplicativo de forma profissional!**