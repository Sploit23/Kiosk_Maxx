# 🔄 Sistema de Atualizações - Photo Kiosk Desktop

## 📋 Visão Geral

O sistema de atualizações foi configurado para funcionar automaticamente através do GitHub Releases, permitindo que os clientes recebam atualizações sem intervenção manual.

## ⚙️ Como Funciona

### 1. Verificação Automática
- O aplicativo verifica atualizações automaticamente a cada inicialização
- Verificações adicionais podem ser feitas através do painel administrativo
- Funciona apenas em modo produção (não em desenvolvimento)

### 2. Download e Instalação
- Quando uma atualização é encontrada, o download inicia automaticamente
- O usuário é notificado sobre o progresso do download
- Após o download, um diálogo pergunta se deseja reiniciar para aplicar

## 🚀 Como Criar uma Nova Versão

### Passo 1: Atualizar Versão
1. Edite o arquivo `package.json` e altere a versão:
   ```json
   "version": "2.0.1"
   ```

2. Edite o arquivo `config/version.json` e atualize:
   ```json
   {
     "version": "2.0.1",
     "build_date": "2025-01-10",
     "changelog": [
       {
         "version": "2.0.1",
         "date": "2025-01-10",
         "changes": [
           "Correção de bugs",
           "Melhorias de performance"
         ]
       }
     ]
   }
   ```

### Passo 2: Fazer Commit e Push
```bash
git add .
git commit -m "Versão 2.0.1 - Correções e melhorias"
git push origin master
```

### Passo 3: Criar Tag e Release
```bash
# Criar tag
git tag v2.0.1
git push origin v2.0.1
```

### Passo 4: Build e Publicação
```bash
# Gerar executáveis
npm run build

# Ou publicar diretamente no GitHub
npm run release
```

## 🤖 GitHub Actions (Automático)

O arquivo `.github/workflows/release.yml` automatiza o processo:

1. **Trigger Automático**: Quando você cria uma tag `v*.*.*`
2. **Build**: Compila o aplicativo para Windows
3. **Release**: Cria automaticamente um release no GitHub com os executáveis

### Para usar o GitHub Actions:
1. Faça push da tag: `git push origin v2.0.1`
2. O GitHub Actions irá:
   - Fazer build do aplicativo
   - Criar o release automaticamente
   - Anexar os arquivos `.exe` e `latest.yml`

## 📁 Arquivos Importantes

### `latest.yml`
Arquivo gerado automaticamente pelo electron-builder que contém:
- Informações da versão mais recente
- Hash dos arquivos para verificação de integridade
- URLs de download

### `config/version.json`
- Versão atual do aplicativo
- Changelog das versões
- URL de verificação de atualizações

### `package.json`
- Configurações do electron-builder
- Configurações de publicação no GitHub
- Scripts de build

## 🔧 Comandos Úteis

```bash
# Desenvolvimento (sem auto-update)
npm run dev

# Produção local
npm start

# Gerar executável (sem publicar)
npm run build

# Gerar e publicar no GitHub
npm run release

# Apenas empacotar (para testes)
npm run pack
```

## 🐛 Solução de Problemas

### Erro: "No releases found"
- Certifique-se de que existe pelo menos um release no GitHub
- Verifique se o repositório está público ou se o token tem permissões

### Erro: "Update check failed"
- Verifique a conexão com a internet
- Confirme se o repositório GitHub está acessível

### Executável não atualiza
- Verifique se o arquivo `latest.yml` está presente no release
- Confirme se a versão no `package.json` é maior que a atual

## 📊 Monitoramento

O sistema registra logs detalhados:
- ✅ Verificações de atualização
- 📥 Progresso de download
- ❌ Erros de conexão ou instalação

## 🔒 Segurança

- Todas as atualizações são verificadas por hash SHA-256
- Downloads apenas de releases oficiais do GitHub
- Verificação de assinatura digital (quando configurada)

---

**⚠️ Importante**: Sempre teste as atualizações em ambiente de desenvolvimento antes de publicar para os clientes!

**📞 Suporte**: Em caso de problemas, verifique os logs do console ou entre em contato com o suporte técnico.