# 📋 Guia Prático: Como Fazer Atualizações do Sistema

## 🎯 Exemplo Prático: Atualizando de v2.0.0 para v2.0.1

Vamos supor que você fez uma alteração no código (ex: corrigiu um bug na impressão) e quer distribuir essa atualização para todos os usuários.

### 📝 Passo 1: Fazer as Alterações no Código

```bash
# Exemplo: você editou algum arquivo, como src/server/server-simple.js
# Fez commit das suas mudanças
git add .
git commit -m "Corrigido bug na impressão de fotos"
```

### 🔢 Passo 2: Atualizar os Números de Versão

**2.1. Edite o `package.json`:**
```json
{
  "name": "photo-kiosk-desktop",
  "version": "2.0.1",  // ← Mude de 2.0.0 para 2.0.1
  // ... resto do arquivo
}
```

**2.2. Edite o `config/version.json`:**
```json
{
  "version": "2.0.1",  // ← Mude de 2.0.0 para 2.0.1
  "build_date": "2025-08-20",  // ← Data atual
  "build_number": 2,  // ← Incremente o número
  "update_url": "https://api.github.com/repos/Sploit23/kiosk-updates/releases/latest",
  "changelog": {
    "2.0.1": {
      "date": "2025-08-20",
      "changes": [
        "Corrigido bug na impressão de fotos",
        "Melhorada estabilidade do sistema"
      ]
    },
    "2.0.0": {
      // ... versão anterior
    }
  },
  "min_version": "2.0.0",
  "force_update": false
}
```

### 💾 Passo 3: Commit e Push das Mudanças

```bash
# Adicionar as mudanças
git add package.json config/version.json
git commit -m "Versão 2.0.1: Corrigido bug na impressão"

# Enviar para o GitHub
git push origin master
```

### 🏷️ Passo 4: Criar a Tag de Versão

```bash
# Criar a tag
git tag v2.0.1

# Enviar a tag para o GitHub
git push origin v2.0.1
```

### 🤖 Passo 5: GitHub Actions Automático

**O que acontece automaticamente:**
1. GitHub detecta a nova tag `v2.0.1`
2. GitHub Actions inicia o workflow de build
3. Compila o aplicativo para Windows
4. Cria os arquivos:
   - `Photo-Kiosk-Desktop-Setup-2.0.1.exe` (instalador)
   - `Photo-Kiosk-Desktop-2.0.1-win.zip` (versão portátil)
   - `latest.yml` (arquivo de metadados para o electron-updater)
5. Cria um release público no GitHub com esses arquivos

### 📱 Passo 6: Usuários Recebem a Atualização

**Para usuários que já têm o app instalado:**
1. Na próxima vez que abrirem o aplicativo
2. Após 5 segundos, o sistema verifica automaticamente por atualizações
3. Se encontrar a v2.0.1, mostra uma notificação:
   ```
   📥 Nova atualização disponível!
   Versão 2.0.1 está disponível.
   Deseja baixar e instalar agora?
   ```
4. Se o usuário aceitar:
   - Download automático em segundo plano
   - Quando terminar, pergunta se quer reiniciar
   - Após reiniciar, a nova versão está instalada

## 🔄 Fluxo Visual Completo

```
[Você faz alterações] 
       ↓
[Atualiza package.json e version.json]
       ↓
[git commit + git push]
       ↓
[git tag v2.0.1 + git push origin v2.0.1]
       ↓
[GitHub Actions detecta a tag]
       ↓
[Build automático do .exe]
       ↓
[Release criado no GitHub]
       ↓
[Usuários recebem notificação automática]
       ↓
[Download e instalação automática]
```

## 🛠️ Comandos Rápidos

### Para Testar Localmente Antes de Publicar:
```bash
npm run dev          # Testar em modo desenvolvimento
npm run dist         # Criar build local (sem publicar)
```

### Para Publicar Nova Versão:
```bash
# 1. Atualizar versões nos arquivos
# 2. Depois executar:
git add .
git commit -m "Versão X.X.X: Descrição das mudanças"
git push origin master
git tag vX.X.X
git push origin vX.X.X
```

## ⚠️ Pontos Importantes

1. **Sempre teste localmente** com `npm run dev` antes de publicar
2. **Mantenha as versões sincronizadas** entre `package.json` e `version.json`
3. **Use versionamento semântico**:
   - `2.0.1` → `2.0.2` (correção de bugs)
   - `2.0.1` → `2.1.0` (nova funcionalidade)
   - `2.0.1` → `3.0.0` (mudança que quebra compatibilidade)
4. **Sempre adicione changelog** no `version.json` explicando as mudanças
5. **A tag deve sempre começar com 'v'** (ex: `v2.0.1`, não `2.0.1`)

## 🔍 Como Verificar se Funcionou

### Verificar se o Release foi Criado:
1. Vá para: https://github.com/Sploit23/kiosk-updates/releases
2. Deve aparecer a nova versão com os arquivos `.exe` e `.zip`

### Verificar se a API está Funcionando:
```bash
# Teste a API de verificação de atualizações
curl http://localhost:5000/api/check-update
```

### Verificar Logs do GitHub Actions:
1. Vá para: https://github.com/Sploit23/kiosk-updates/actions
2. Veja se o workflow da sua tag executou com sucesso

## 🆘 Solução de Problemas

**Se o GitHub Actions falhar:**
- Verifique os logs em: https://github.com/Sploit23/kiosk-updates/actions
- Problemas comuns: dependências em falta, erro de sintaxe no código

**Se os usuários não receberem a atualização:**
- Verifique se o release foi criado corretamente
- Confirme que o arquivo `latest.yml` está presente no release
- Teste a API: `curl https://api.github.com/repos/Sploit23/kiosk-updates/releases/latest`

**Se o build local falhar:**
```bash
npm install          # Reinstalar dependências
npm run dev          # Testar se roda localmente
```

---

**🎉 Pronto! Agora você sabe exatamente como fazer atualizações do seu sistema de forma profissional e automática.**