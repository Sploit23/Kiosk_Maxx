# 🎄 Photo Kiosk Desktop - Sistema de Quiosque de Fotos Profissional

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Electron](https://img.shields.io/badge/Electron-28.1.0-blue.svg)

## 📋 Visão Geral

O **Photo Kiosk Desktop** é um sistema completo de quiosque de fotos desenvolvido em Electron, projetado para uso profissional em estabelecimentos comerciais. O sistema oferece uma interface moderna e intuitiva para impressão de fotos com integração nativa às impressoras FUJIFILM ASK-300 e ASK-400.

### ✨ Características Principais

- 🖥️ **Aplicação Desktop Electron** com interface moderna
- 🖨️ **Integração com Impressoras FUJIFILM** (ASK-300 e ASK-400)
- 🎨 **Interface Touch-Friendly** otimizada para quiosques
- 🎄 **Tema Natalino** com efeitos visuais modernos
- 🔄 **Sistema de Auto-Update** integrado
- 💰 **Sistema de Vendas** com controle de preços
- ⚙️ **Painel Administrativo** completo
- 🛒 **Sistema de Carrinho** para múltiplas impressões

## 🏗️ Arquitetura do Sistema

### Estrutura de Diretórios

```
kioskEletron/
├── src/
│   ├── electron/           # Aplicação Electron principal
│   │   ├── main.js         # Processo principal
│   │   └── preload.js      # Script de pré-carregamento
│   ├── server/             # Servidor HTTP interno
│   │   └── server-simple.js # Servidor Node.js
│   ├── ui/                 # Interface do usuário
│   │   ├── app/            # Páginas HTML principais
│   │   └── static/         # Recursos estáticos (CSS, JS, imagens)
│   └── utils/              # Utilitários diversos
├── config/                 # Arquivos de configuração
│   ├── printer_config.json # Configurações de impressoras
│   ├── pricing.json        # Configurações de preços
│   ├── settings.json       # Configurações gerais
│   └── themes.json         # Configurações de temas
├── output/                 # Arquivos de saída de impressão
├── dist/                   # Build da aplicação
└── package.json           # Dependências e scripts
```

### Componentes Principais

#### 1. **Aplicação Electron** (`src/electron/`)
- **main.js**: Processo principal que gerencia janelas e integração com o sistema
- **preload.js**: Script de segurança para comunicação entre processos
- Integração com sistema de auto-update
- Controles de janela e modo quiosque

#### 2. **Servidor HTTP** (`src/server/server-simple.js`)
- Servidor Node.js interno rodando na porta 5000
- APIs RESTful para impressão e configuração
- Sistema de detecção automática de impressoras
- Integração com sistema de impressão nativa do Windows

#### 3. **Interface do Usuário** (`src/ui/`)
- **Interface Principal**: Galeria de fotos com navegação intuitiva
- **Painel Administrativo**: Configurações e estatísticas
- **Sistema de Configuração**: Gerenciamento de impressoras e preços
- **Carrinho de Compras**: Sistema de múltiplas seleções

## 🖨️ Sistema de Impressão

### Impressoras Suportadas

- **FUJIFILM ASK-300**: Impressora padrão para formatos 10x15 e 15x20
- **FUJIFILM ASK-400**: Impressora avançada com suporte a múltiplos formatos

### Formatos de Papel

| Formato | Dimensões | Preço Padrão | Impressora Recomendada |
|---------|-----------|--------------|------------------------|
| 10x15   | 10cm x 15cm | R$ 15,00 | ASK-300/ASK-400 |
| 15x20   | 15cm x 20cm | R$ 25,00 | ASK-400 |
| Bolas   | Personalizado | R$ 15,00 | ASK-300/ASK-400 |

### Tecnologias de Impressão

1. **Impressão Nativa do Windows**
   - Utiliza `rundll32.exe shimgvw.dll,ImageView_PrintTo`
   - Otimização automática de imagem pelo Windows
   - Suporte a múltiplas cópias

2. **Sistema Java Integrado**
   - Classes Java específicas para cada modelo de impressora
   - `ImprimirFoto10x15ASK300/ASK400`
   - `ImprimirFoto15x20ASK300/ASK400`
   - `ImprimirFotoBolasASK300/ASK400`

## ⚙️ Configuração

### Arquivos de Configuração

#### `config/printer_config.json`
```json
{
  "last_used_printer": "FUJIFILM ASK-400",
  "user_preferences": {
    "default_printer": "FUJIFILM ASK-400",
    "default_format": "10x15",
    "auto_print_copies": 1
  },
  "format_mappings": {
    "10x15": {
      "printer": "FUJIFILM ASK-400",
      "java_class": "ImprimirFoto10x15ASK400"
    }
  }
}
```

#### `config/pricing.json`
```json
{
  "default_price": 15,
  "formats": {
    "10x15": 15,
    "15x21": 25,
    "20x30": 35
  },
  "currency": "BRL",
  "tax_rate": 0
}
```

#### `config/settings.json`
```json
{
  "admin_password": "869407",
  "server": {
    "host": "0.0.0.0",
    "port": 5000,
    "debug": true
  },
  "image_settings": {
    "base_path": "C:\\path\\to\\images",
    "allowed_extensions": [".jpg", ".jpeg", ".png"]
  }
}
```

## 🚀 Instalação e Execução

### Pré-requisitos

- **Node.js** 18+ 
- **Windows 10/11**
- **Java JDK** 8+ (para sistema de impressão)
- **Impressoras FUJIFILM** ASK-300 ou ASK-400 configuradas

### Instalação

1. **Clone o repositório**
```bash
git clone https://github.com/seu-usuario/photo-kiosk-desktop.git
cd photo-kiosk-desktop
```

2. **Instale as dependências**
```bash
npm install
```

3. **Configure as impressoras**
```bash
npm run compile-java
```

4. **Execute o setup inicial**
```bash
npm run setup
```

### Execução

#### Modo Desenvolvimento
```bash
npm run dev
```

#### Modo Produção
```bash
npm start
```

#### Build para Distribuição
```bash
npm run build
```

## 🎨 Interface do Usuário

### Tela Principal
- **Sidebar**: Lista de fotos com navegação por categorias
- **Área Principal**: Visualização da foto selecionada
- **Controles de Impressão**: Seleção de formato e quantidade
- **Carrinho**: Sistema de múltiplas seleções
- **Resumo da Impressora**: Status atual das configurações

### Painel Administrativo
- **Dashboard**: Estatísticas de vendas e uso
- **Configurações**: Gerenciamento de impressoras e preços
- **Sistema**: Controles do Electron e atualizações
- **Relatórios**: Histórico de vendas e impressões

### Recursos de Acessibilidade
- **Interface Touch**: Botões otimizados para tela touch (mínimo 60px)
- **Feedback Visual**: Efeitos hover e active responsivos
- **Navegação por Teclado**: Suporte completo a navegação por teclado
- **Alto Contraste**: Tema com boa legibilidade

## 🔧 APIs Disponíveis

### Impressão
- `POST /api/print-configured` - Impressão com configurações salvas
- `GET /api/printers` - Lista impressoras disponíveis
- `GET /api/printer-status` - Status das impressoras

### Configuração
- `GET /api/config` - Obter configurações
- `POST /api/config` - Salvar configurações
- `GET /api/printer-config` - Configurações de impressora

### Sistema
- `GET /api/system-info` - Informações do sistema
- `GET /api/version` - Versão da aplicação
- `POST /api/update-check` - Verificar atualizações

## 🛠️ Desenvolvimento

### Estrutura de Desenvolvimento

```bash
# Instalar dependências de desenvolvimento
npm install --dev

# Executar em modo desenvolvimento
npm run dev

# Compilar scripts Java
npm run compile-java

# Build para produção
npm run build

# Criar pacote portável
npm run pack
```

### Tecnologias Utilizadas

- **Frontend**: HTML5, CSS3, JavaScript ES6+
- **Backend**: Node.js, HTTP nativo
- **Desktop**: Electron 28.1.0
- **Impressão**: Java + Windows Native Printing
- **Build**: Electron Builder
- **Auto-Update**: Electron Updater

### Padrões de Código

- **ES6+ JavaScript** com async/await
- **CSS Modular** com variáveis CSS customizadas
- **Responsive Design** com mobile-first approach
- **Lazy Loading** para otimização de performance
- **Error Handling** robusto em todas as operações

## 📊 Monitoramento e Logs

### Sistema de Logs
- **Console Logs**: Desenvolvimento e debug
- **File Logs**: Produção (em implementação)
- **Error Tracking**: Captura de erros não tratados

### Métricas
- **Vendas por Dia**: Controle financeiro
- **Impressões por Formato**: Análise de uso
- **Status de Impressoras**: Monitoramento de hardware
- **Performance**: Tempo de resposta das operações

## 🔒 Segurança

### Medidas Implementadas
- **Content Security Policy**: Proteção contra XSS
- **Senha Administrativa**: Acesso restrito ao painel admin
- **Validação de Entrada**: Sanitização de dados
- **Isolamento de Processos**: Electron security best practices

## 🚨 Solução de Problemas

### Problemas Comuns

#### Impressora não detectada
1. Verificar se a impressora está ligada e conectada
2. Executar `criar_impressoras_final.cmd` como administrador
3. Verificar drivers FUJIFILM instalados
4. Reiniciar o serviço de spooler do Windows

#### Erro de impressão
1. Verificar configurações em `/config/printer_config.json`
2. Testar impressão direta pelo Windows
3. Verificar logs do servidor na porta 5000
4. Recompilar scripts Java: `npm run compile-java`

#### Interface não carrega
1. Verificar se o servidor está rodando na porta 5000
2. Limpar cache do Electron
3. Verificar permissões de arquivo
4. Executar como administrador se necessário

## 📝 Changelog

### v2.0.0 (Atual)
- ✅ Migração completa para Electron
- ✅ Sistema de auto-update integrado
- ✅ Interface moderna com tema natalino
- ✅ Otimizações para tela touch
- ✅ Sistema de carrinho aprimorado
- ✅ Detecção automática de impressoras
- ✅ Impressão nativa do Windows

### v1.x (Legado)
- Sistema web básico
- Integração Java manual
- Interface desktop simples

## 🤝 Contribuição

Contribuições são bem-vindas! Por favor:

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está licenciado sob a Licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

## 👥 Equipe

- **Desenvolvimento**: Equipe Photo Kiosk System
- **Contato**: contato@photokiosk.com
- **Suporte**: Disponível via GitHub Issues

## 🔗 Links Úteis

- [Documentação Electron](https://www.electronjs.org/docs)
- [FUJIFILM ASK Series](https://fujifilm.com/ask-series)
- [Node.js Documentation](https://nodejs.org/docs)
- [Windows Printing API](https://docs.microsoft.com/windows/printing)

---

**Desenvolvido com ❤️ para profissionais de fotografia**

*Última atualização: Janeiro 2025*