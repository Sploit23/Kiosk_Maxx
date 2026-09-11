# AGENTS.md — Kiosk Foto (Maxx Foto Vendas / Natal 2026)

Guia de contexto para agentes que trabalharem neste repositório. Descreve a
arquitetura, os backends, onde/como o frontend se conecta e todos os endpoints.

## Visão geral

Sistema de **quiosque PDV de fotos** para o evento "NATAL 2026". É um app
**desktop Electron para Windows** em que o cliente fotografa, escolhe formatos
no editor de enquadramento, paga e imprime na hora numa **Fujifilm ASK-400**.

- **UI (frontend):** dupla entrada Vite — `index.html` (React, refatoração) e
  `vendas.html` (PDV vanilla JS/DOM, a que o Electron carrega em produção).
- **Backend local:** `sidecar/natal-core.cjs` — servidor Node HTTP (0
  dependências) na porta **9877**.
- **Backend cloud:** `backend/api.php` — API PHP single-file publicada na web
  para cadastro de lojas/equipe (portal de gestão).
- **Backend de impressão:** `impressora/status_ok/sidecar-ask400.jar` — sidecar
  Java que controla a ASK-400 via JNI/DLL, na porta **8080**.

Persistência é **sem banco SQL**: tudo em arquivos JSON (local em
`%APPDATA%\natal-app\`, cloud em `backend/data\`).

## Arquitetura e como as partes se conectam

```
┌─────────────── Electron (main) ──────────────────────────────┐
│  electron-main.cjs: spawns natal-core.cjs, IPC, auto-update  │
│  preload.cjs: bridge window.natal (getConfig, fullscreen,    │
│               printGuia, auto-update...)                     │
├─────────────── UI (vendas.html / index.html) ────────────────┤
│  importa shared/ (config, api, components, utils)            │
└───────┬──────────────────────────────┬──────────────────────┘
        │ REST + SSE (fetch/EventSource)│ REST (fetch)
        ▼                              ▼
┌─ sidecar natal-core.cjs ──┐   ┌─ portal PHP cloud ──────────────┐
│  Node http, 0.0.0.0:9877  │   │  maxxfoto.com.br/natalcontroler │
│  arquivos em %APPDATA%    │   │  api.php (login/equipe/admin)   │
│  orquestra impressão      │   │  dados em backend/data/*.json   │
└──────┬───────────────────┘   └─────────────────────────────────┘
       │ HTTP localhost:8080
       ▼
┌─ sidecar Java ASK-400 ────┐
│  sidecar-ask400.jar       │
│  /health, /kws/v1/...     │
│  PicgoAsk400.dll,         │
│  ASK400Stat.dll           │
└───────────────────────────┘
```

- **Cadeia de impressão:** UI → `natal-core.cjs` (fila de impressão via
  `POST /api/pedidos/:id/impressao/:filename`) → `POST /api/pedidos/:id/imprimir`
  → sidecar Java (porta 8080, `media=6x4|6x8`) → impressora. O core consome o
  contador de ribbon e marca a sessão `FINALIZADA` no fim. No PDV
  (`vendas.html`), `iniciarImpressaoFotos()` compõe cada foto (canvas 300 DPI +
  molde, `composePrintImage`), faz o upload e dispara a impressão em background;
  o progresso vai para o chip de papel (`_printProgress`, `Imprimindo X/Y`).
  Falhas abrem um modal com "Tentar novamente" (`imprimirFotosPendentes`) e o
  resumo da venda tem botão manual "Imprimir fotos na ASK-400". O lado do
  cliente recebe `print-start`/`printer:progress`/`print-complete` via SSE.
- **Autenticação offline-first:** a UI tenta `portalApi.login()` primeiro; se o
  portal estiver fora do ar, cai para credenciais locais (`src/catalog.js`).
- **Config em runtime:** `shared/config.js` tem defaults; o preload bridge
  (`window.natal.getConfig()`) sobrescreve com `electron-config.json`
  (procura em `C:\ProgramData\MaxxNatal\` → local → `electron-config.template.json`).

## Endpoints — sidecar local (`http://<host>:9877`)

Fonte: `sidecar/natal-core.cjs`. Todas as respostas são JSON; CORS liberado
(header `Access-Control-Allow-Origin: *`).

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/events` | SSE (`text/event-stream`) de eventos |
| GET | `/api/health` | `{ ok, pdv, time, ribbon }` |
| GET | `/api/printer/status` | Status real da ASK-400 (proxy p/ Java: papel 10x15/15x20, connected, lastError) |
| GET | `/api/config` | Config da máquina + ribbon |
| POST | `/api/config` | Salva config da máquina |
| POST | `/api/sessoes` | Criar sessão (`NATAL-<numero>`, estado `CRIADA`) |
| GET | `/api/sessoes` | Listar sessões (com fotos) |
| GET | `/api/sessoes/:id` | Buscar uma sessão |
| POST | `/api/sessoes/:id/originais/:filename` | Upload foto original (binário cru) |
| POST | `/api/sessoes/:id/previews/:filename` | Upload preview (binário cru) |
| POST | `/api/sessoes/:id/finalizar` | Marca `PRONTA` (exige ter fotos) |
| POST | `/api/sessoes/:id/cancelar` | Marca `CANCELADA` |
| GET | `/api/fotos/(originais\|previews)/:id/:filename` | Serve imagem (`image/jpeg`) |
| POST | `/api/pedidos` | Criar pedido (exige caixa aberto + sessão) → `AGUARDANDO` |
| GET | `/api/pedidos` | Listar pedidos (mais novos primeiro) |
| GET | `/api/pedidos/:id` | Buscar pedido (por `id` ou `numero`) |
| POST | `/api/pedidos/:id/pagamento` | Registra pagamento → `PAGO`, sessão `VENDIDA` |
| POST | `/api/pedidos/:id/impressao/:filename` | Upload da imagem final de impressão (fila) |
| POST | `/api/pedidos/:id/imprimir` | Dispara pipeline de impressão (exige `PAGO`) |
| GET | `/api/pdv/caixa` | Estado do caixa atual |
| GET | `/api/pdv/caixas` | Histórico de caixas fechados (persistido em `caixas.json`, ordenado do mais recente primeiro) |
| POST | `/api/pdv/caixa/abrir` | Abre caixa (`CX-...`) |
| POST | `/api/pdv/caixa/fechar` | Fecha caixa (conciliação: totalVendido, totalPorMeio, meiosDeclarados, totalRecebido, diferenca, valorEnvelope, saldoRestante, fechadoPor, numero) e arquiva no histórico |
| OPTIONS | qualquer | CORS preflight |

**Eventos SSE emitidos:** `sessao:criada`, `sessao:status`, `sessao:concluida`,
`pedido:criado`, `pedido:pago`, `print-start`, `printer:progress`,
`print-complete`, `caixa:aberto`, `caixa:fechado`. Cliente:
`shared/api/sse.js` `connectSSE(onEvent, onStatus)` é **multi-listener** (portado
do kiosk-app) — cada chamada registra um callback no mesmo `EventSource`, em vez
de reabrir a conexão.

## Endpoints — portal PHP cloud (`api.php`)

Fonte: `backend/api.php`. Ação via `action` na query string ou no corpo JSON.
Autenticação pública por usuário; ações admin exigem header `X-Token` (ou campo
`token`). Tokens admin duram 12h.

**Públicas:**

| Ação | Parâmetros | Descrição |
|---|---|---|
| `health` | — | Status da API: `{ ok, app, version, php, time }` |
| `login` | `lojaId`, `usuario`, `senha` | Valida loja + usuário (usuário ou nome) + senha → `{ user, loja }` |
| `equipe` | `lojaId` | Lista usuários ativos da loja: `{ loja, usuarios }` |
| `precos` | `lojaId` | Preços do catálogo da loja (fonte de verdade do PDV): `{ ok, lojaId, precos }` — defaults oficiais + overlay salvo no admin (`data/precos.json`) |
| `kiosk.pair` | `kioskCode` (+ `pdvNome`, `machineId`; legado `lojaId`+`pairingCode`) | Emparelha o kiosk com a loja: resolve a loja pelo código exibido NA TELA do PDV, registra `pareamento` e bloqueia máquina já usada por outra loja (`KIOSK_NAO_EMPARELELHADO`, `MAQUINA_JA_EMPARELHADA`) → `{ loja, pareamento }` |
| `vendas.push` | `lojaId`, `machineId`, `data` (YYYY-MM-DD) + snapshot | PDV → portal: snapshot diário de vendas por loja. Exige `machineId` == `pareamento.machineId` da loja (`LOJA_NAO_EMPARELELHADA` 403, com delay anti-bruteforce). Upsert em `data/vendas.json` por loja+data: `lojaNome`, `pdvNome`, `totalVendido`, `pedidos`, `sessoesCriadas`, `sessoesVendidas`, `taxacombo`, `ribbonRestante`, `papel10x15`/`papel15x20` (papel REAL da impressora via checkPrinter, `null` se sem resposta), `meios {dinheiro,debito,credito,pix}`, `ultimaVenda`, `caixa {numero,aberto}`, `enviadoEm` |
| `pedido.push` | `lojaId`, `machineId` + `pedido` (objeto) | PDV → portal: pedido completo, **idempotente pelo `pedido.id`** (reenvio só sobrescreve). Exige máquina pareada (mesmo bloqueio do `vendas.push`). Normaliza `itens [{tipo,produtoId,label,qtd,unidades,precoUnit,subtotal}]`, `pagamentos [{meio,forma,valor,parcelas}]`, `sessoes`, `desconto`, `caixaId`, `origemPedidoId`, `guiaImpressa`, `unidadesTotal` (somada dos itens). Alimenta Pedidos/Ranking/DRE. Persistido em `data/pedidos.json` |
| `auditoria.push` | `lojaId`, `machineId` + `uso` (objeto) | PDV → portal: uso de senha master (perda, desconto/cancelamento, cobrança de diferença), **idempotente pelo `uso.id`**. Campos: `titulo`, `operador`, `motivo`, `data`, `criadoEm`, `pedidoContexto`, `pedidoGeradoId`. Persistido em `data/auditoria.json`, alimenta a tela Auditoria |

**Admin (token):** `admin.login` (valida senha SHA-256 → `{ token, expiraEm }`),
`lojas.list` (lojas com status de conexão: `online`/`ultimaConexao`/
`conexaoDelta` derivados do `enviadoEm` mais recente em `vendas.json`/
`pedidos.json`/`auditoria.json` — ONLINE se última conexão ≤ 10 min,
`ONLINE_JANELA_SEG` no `api.php`; o PDV manda snapshot a cada 5 min, então
esse campo é o heartbeat do kiosk), `lojas.save`, `lojas.delete`, `usuarios.list`, `usuarios.save`,
`usuarios.delete`, `precos.save` (salva `{ lojaId, precos }` em
`data/precos.json`; valores vazios resetam para os defaults),
`vendas.resumo` (todos os snapshots de `data/vendas.json`, data desc → lojaId asc →
`{ ok, vendas }`), `pedido.list` (pedidos consolidados de `data/pedidos.json`,
filtros `lojaId`/`dataIni`/`dataFim`/`q`/`status`, sort criadoEm desc →
`{ ok, pedidos, total, totalLiquido }` − exclui status `cancelado` do
totalLiquido), `auditoria.list` (usos de `data/auditoria.json`, filtros
`lojaId`/`dataIni`/`dataFim`, sort criadoEm desc → `{ ok, usos }`),
`parametros.get`/`parametros.save` (parâmetros globais do DRE/estoque em
`data/parametros.json` — ver `PARAMS_DEFAULT` abaixo; save aceita qualquer
subconjunto, comissões cap 100),
`despesas.list`/`despesas.save`/`despesas.delete` (CRUD de
despesas manuais da gestão em `data/despesas.json`,
`{ id: 'DESP-*', lojaId, data, categoria, descricao, valor, criadoEm }`),
`admin.changePassword`. Ação desconhecida → `ACAO_DESCONHECIDA`.

**Parâmetros globais (`data/parametros.json`, defaults em `PARAMS_DEFAULT` do
`api.php`):** `custoRibbonUnitario` (R$/un, 0), `comissaoVendedor` (%) e
`comissaoFotografo` (%) aplicadas sobre a receita de cada operador no DRE,
`ribbonCritico` (un., 100) — limite usado pela tela Estoque no status do kit.

## Endpoints — sidecar Java ASK-400 (`http://localhost:8080`)

Fonte: `impressora/status_ok/` (ver `RESUMO.md`).

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health-check |
| GET | `/kws/v1/kiosk/checkPrinter` | Status da impressora (papel restante) |
| GET | `/kws/v1/printer/print2?code=<dir>&media=6x4\|6x8` | Imprime fotos de um diretório |

O core do Node chama `/kws/v1/kiosk/checkPrinter` para o endpoint
`/api/printer/status` e usa `/kws/v1/printer/print2` no pipeline de impressão.

O **JRE 8 32-bit vem embutido** no instalador (`resources/jre8/`, vindo de
`jre8/runtime` — pasta gitignorada, baixada do Adoptium no CI). O
`findJava()` em `electron-main.cjs` prioriza o JRE embutido antes de procurar
JRE instalado na máquina, então o PDV não depende de instalação externa.

## Estrutura de diretórios

```
├── electron-main.cjs        # Processo main Electron (spawn sidecar, IPC, update)
├── preload.cjs              # Bridge window.natal
├── index.html               # Entrada React (refatoração)
├── vendas.html              # Entrada PDV (vanilla JS — carregada em produção)
├── vite.config.js           # base './', inputs main+pdv, alias @shared
├── electron-config.template.json  # Template de config da máquina
├── package.json             # Scripts; deps: electron-updater apenas
├── src/                     # App React: App.jsx (máquina de estados das telas),
│   │                        #   catalog.js (loja/usuários fi/descontos/meios), screens/*
│   └── components/
├── shared/
│   ├── config.js            # Fonte única de verdade (URLs, formatos, preços, timers)
│   ├── i18n.js              # Strings pt-BR
│   ├── api/
│   │   ├── natalApi.js      # Adapter REST → sidecar (porta 9877)
│   │   ├── portalApi.js     # Adapter REST → portal PHP
│   │   └── sse.js           # Cliente EventSource com retry/backoff
│   ├── components/AdjustFraming.jsx  # Editor de enquadramento React
│   └── utils/               # imageUtils, pricing, printUtils (300 DPI), thumbnailUtils
├── sidecar/
│   └── natal-core.cjs       # Backend local (Node http, 0 deps)
├── backend/
│   ├── api.php              # API cloud single-file
│   ├── config.php           # APP_DATA_DIR + ADMIN_SENHA_SHA
│   ├── admin.html           # Portal de gestão (SPA vanilla JS)
│   ├── publish.ps1          # Deploy FTP (HostGator)
│   └── data/                # JSONs (bloqueado por .htaccess)
├── impressora/
│   ├── native_libs/picgo-ask400/   # DLLs da ASK-400 + perfil ICC
│   └── status_ok/                   # Sidecar Java (build/, build.ps1, RESUMO.md)
├── public/overlays/         # PNGs de overlay (bolinha, 10x15, 15x20)
├── dist/                    # Build Vite (index.html, vendas.html, assets/, overlays/)
└── .github/workflows/       # ci.yml + release.yml (tag v* → build win + publish)
```

## Modelos de dados (arquivos JSON)

**Sidecar local — `%APPDATA%\natal-app\`:**

- **Sessão** (`sessoes/NATAL-XXXXX/meta.json` + pastas `previews/` e `originais/`):
  `{ id, estado, criadaEm, fotosEsperadas, operadorFotografo, prontaEm?,
     finalizadaEm?, canceladaEm?, pedidoNumero?, fotos: [{name, preview, original}], fotosQtd }`
  Estados: `CRIADA → FOTOGRAFANDO → RECEBENDO → PRONTA → EM_ATENDIMENTO →
  VENDIDA → FINALIZADA` (ou `CANCELADA`).
- **Pedido** (`database/pedidos.json`): `{ id: 'PED-*', numero, sessaoId,
  itens: [{key, qty, filename, scale, diffx, diffy, angle, orientation,
  unitPrice, subtotal}], produtos: [{key, qty, unitPrice, subtotal}], total,
  caixaId, status: AGUARDANDO|PAGO|IMPRESSO, criadoEm, meio, pagamentos:
  [{meio, valor, parcelas?}], origemPedidoId?, operador?, desconto?, pagoEm?,
  guiaImpressa, impressoEm? }`
- **Caixa** (`database/caixa.json`): `{ id: 'CX-*', operador, valorInicial,
  abertoEm, fechadoEm?, pedidos: [], meios: {}, totalVendido?, totalPorMeio?,
  meiosDeclarados?, totalRecebido?, diferenca?, valorEnvelope?, saldoRestante?,
  fechadoPor?, numero?, observacoes? }`
- **Histórico de caixas** (`database/caixas.json`): array de caixas fechados
  (campos do fechamento acima), persistido a cada `caixa:fechado` e servido por
  `GET /api/pdv/caixas` (mais recente primeiro).
- **Contadores:** `counter.txt` (sessões), `ribbon-counter.txt` (ribbon da
  impressora, default 400), `config.json` (config da máquina).

**Portal PHP — `backend/data/app.json`:**

- **Loja:** `{ id, nome, pdv, ativo, kioskCode?, pairingCode?, pareamento? }` —
  `pareamento = { pdvNome, machineId, emparelhadoEm }` gravado por `kiosk.pair`.
  O `kioskCode` (8 chars, exibido na TELA do PDV) é digitado pelo admin na
  loja — é o que ata a máquina física à loja; ele é único por loja
  (`CODIGO_EM_USO`). `pairingCode` é o fluxo legado (código gerado no admin).
- **Usuário:** `{ id: 'u-*', lojaId, usuario, nome, funcao:
  vendedor|fotografo|admin|gerente, senha (texto puro no arquivo), ativo }`
- **`admin.json`:** `{ hash }` (senha admin SHA-256, default = hash do valor em
  `backend/config.php`), **`tokens.json`:** `{ token: expiraEm }`.
- **Despesas (`data/despesas.json`):** array de despesas lançadas manualmente
  pela gestão (não vêm do PDV): `{ id: 'DESP-*', lojaId, data
  (YYYY-MM-DD), categoria, descricao, valor, criadoEm }`. Administrado pela
  tela "Despesas & Taxas" (`admin.html`, render `despesas.list/save/delete`,
  resultado = receita do período − despesas).
- **Vendas (`data/vendas.json`):** array de snapshots diários por
  `(lojaId, data)` enviados pelo PDV (`vendas.push`). Campos: `lojaId`,
  `lojaNome`, `pdvNome`, `machineId`, `data`, `totalVendido`, `pedidos`,
  `sessoesCriadas`, `sessoesVendidas`, `taxacombo`, `ribbonRestante`,
  `papel10x15`/`papel15x20` (papel real da impressora, `null` se sem resposta),
  `meios {dinheiro,debito,credito,pix}`, `ultimaVenda`, `caixa {numero,aberto}`,
  `enviadoEm`. Administrado pelas telas "Dashboard" (KPIs de vendas de hoje) e
  "Vendas & BI" (`admin.html`, `vendas.resumo`); a tela "Estoque" usa o papel
  real (menor dos dois gaveteiros) como saldo efetivo, com o ribbon como fallback.
- **Pedidos (`data/pedidos.json`):** array de pedidos consolidados por `pedido.id`
  (`pedido.push`), em ordem de chegada. Campos: `id` (origem: `_realId` do PDV),
  `numero`, `lojaId`, `lojaNome`, `pdvNome`, `machineId`, `data`, `criadoEm`,
  `pagoEm`, `total`, `status` (pago/impresso/cancelado), `operador`,
  `unidadesTotal`, `itens [{tipo,produtoId,label,qtd,unidades,precoUnit,subtotal}]`,
  `pagamentos [{meio,forma,valor,parcelas}]`, `sessoes`, `desconto`, `caixaId`,
  `origemPedidoId`, `guiaImpressa`, `enviadoEm`. Alimenta as telas "Pedidos",
  "Ranking" (agrega por operador/loja) e o DRE do "Financeiro"
  (`pedido.list`).
- **Auditoria (`data/auditoria.json`):** array de usos de senha master por
  `uso.id` (`auditoria.push`). Campos: `id`, `lojaId`, `lojaNome`, `pdvNome`,
  `machineId`, `data`, `criadoEm`, `titulo` (perda/desconto/cancelamento/
  cobrança de diferença), `operador`, `motivo`, `pedidoContexto`,
  `pedidoGeradoId`, `enviadoEm`. Tela "Auditoria" (`auditoria.list`).
- **Parâmetros (`data/parametros.json`):** parâmetros globais da gestão
  (`parametros.save`), defaults em `PARAMS_DEFAULT` do `api.php` — ver sessão
  "Admin (token)" acima.

## Configurações

- **`shared/config.js`** — fonte única: `serverUrl` (default
  `http://localhost:9877`), `portalApiUrl` (`https://maxxfoto.com.br/natalcontroler/api.php`),
  `lojaId` (`teste`), `pairingCode`, `pdvNome`, formatos de foto, produtos,
  pricing, overlays, estados, meios de pagamento (`dinheiro`, `pix`, `debito`,
  `credito`) e timers.
- **Preços — fonte de verdade no portal:** o PDV (`vendas.html`) busca
  `portalApi.precos()` no boot e a cada emparelhamento e sobrescreve o catálogo
  local (`TAMANHOS`/`EXTRAS`/combos). O admin edita por loja em "Catálogo de
  produtos". `shared/config.js` `PRICING` é apenas o fallback offline (valores
  oficiais do evento).
- **`electron-config.template.json`** — `renderServerUrl`, `serverUrl`,
  `thermalPrinterName`, `pdvNome` (`VENDA-01`), `portalApiUrl`, `lojaId`,
  `pairingCode` (código gerado no admin do portal; vazio = sem emparelhamento),
  `photosFolder` (pasta de fotos configurável pelo modal ⚙ do PDV).
- **Emparelhamento (`kiosk.pair`)** — **zero config manual no kiosk.** No boot,
  o PDV (`vendas.html`, React em `shared/api/kiosk.js`) garante que a config do
  sidecar tem `machineId` + `kioskCode` (gerados no 1º boot, persistidos e
  mostrados na tela de login e no modal ⚙). O admin digita esse código na loja
  do portal; em loop de 30s o PDV chama `kiosk.pair({ kioskCode, pdvNome,
  machineId })`, o portal devolve o `lojaId` canônico, que o PDV carimba na
  config do sidecar e no `electron-config.json` (`window.kioskPair`). Depois de
  emparelhado, `portalApi.login()/equipe()` usam o `lojaId` devolvido no lugar
  do `config.lojaId`. Bloqueio de clone: `KIOSK_NAO_EMPARELELHADO`,
  `MAQUINA_JA_EMPARELHADA`, `CODIGO_EM_USO`.
- **Sync de vendas → portal (`vendas.html`)** — o PDV calcula o snapshot do dia
  (`enviarSnapshotVendas` em `vendas.html`; `portalApi.vendasPush` em
  `shared/api/portalApi.js`) e envia via `vendas.push`: 4s após o boot, 3s após
  emparelhar, com debounce em `pedido:pago`/`caixa:aberto`/`caixa:fechado`
  (SSE) e `setInterval` de 5 min. Só envia se `window.kioskPair` existir (loja
  canônica + `machineId`). Snapshot do dia = pedidos `PAGO`, total de hoje,
  sessões criadas/vendidas de hoje, taxa de combos %, ribbon restante (contador
  interno) + papel real da impressora (10x15/15x20 via `checkPrinter`), último
  pagamento e caixa atual. Offline/falha: tenta de novo no próximo tick.
- **Sync pedido-a-pedido → portal (`vendas.html`)** — no mesmo tick do snapshot,
  o PDV envia cada pedido completo via `pedido.push` (`enviarPedidosDia` →
  `portalApi.pedidoPush` em `shared/api/portalApi.js`): no 1º boot emparelhado
  sobe todo o histórico `PAGO` (flag `_pushHistoricoPedidos`), depois só os de
  hoje; `agendarPedidosPortal(ms)` dispara ~800ms após uma venda nova
  (`finalizarVenda`) e após cancelamento (idempotente pelo `pedido.id` = `_realId`).
- **Auditoria → portal (`vendas.html`)** — usos de senha master
  (`usosSenhaLog`) são persistidos no sidecar (`persistirAuditoria` →
  `natalApi.auditoriaSave`, arquivo `auditoria.json` local) e enviados ao portal
  via `auditoria.push` (`enviarAuditoriaPendente`, só `!_portalEnviado`) a cada
  uso (perda/desconto/cancelamento/cobrança) e no tick do snapshot; `carregarAuditoria()`
  no boot reidrata o log local como já enviado (`_portalEnviado: true`).
- **Config da máquina (sidecar)** — `%APPDATA%\natal-app\database\config.json`
  guarda `{ pdvNome, photosFolder, thermalPrinterName, machineId, lojaId,
  pairingCode }` via `GET/POST /api/config`; a UI salva também no
  `electron-config.json`.
- **Botão ⚙ Config** (`vendas.html`) — abre modal com seletor de pasta nativa
  (IPC `natal:selectFolder` → `dialog.showOpenDialog`) + status real da
  impressora (10x15/15x20, connected, lastError), e salva nos dois lugares.
- **Importador de pasta de fotos** (`natal-core.cjs`) — regra da drop zone em
  `photosFolder`: **1 subpasta = 1 sessão**. O programa externo cria uma
  subpasta por cliente e salva `*.jpg|*.jpeg|*.png` nela; o sidecar escaneia a
  cada 1,5s e, quando a subpasta fica estável por 8s (sem alterações), cria a
  sessão `NATAL-XXXXX`, copia as fotos (original + preview normalizado `.jpg`),
  marca `PRONTA` automaticamente e move a subpasta para
  `photosFolder/importadas/NATAL-XXXXX/`. `criadaEm` da sessão = o instante em
  que a subpasta foi criada (birthtime; fallback: criação da 1ª foto) — momento
  em que o cliente terminou de fotografar —, e `prontaEm` = instante do import.
  Arquivos < 1KB ou com tail `.part/.tmp/.crdownload/.download` são ignorados
  (cópia pela metade). Troca de pasta na config vale na hora.
- **`vite.config.js`** — alias `@shared` → `./shared`, dedupe de React, porta
  de dev 5173.

## Comandos

- `npm start` / `npm run electron:dev` — Vite (5173) + Electron (PDV real)
- `npm run dev` — só Vite
- `npm run build` — build Vite (main + pdv) para `dist/`
- `npm run build:win` — build + empacotador (NSIS)
- `npm run release` — build + publish GitHub (release)
- `npm run lint` — ESLint
- `backend/publish.ps1` — deploy FTP do portal PHP (credenciais em `../../credencial.txt`)

- **Auto-update (electron-updater):** o main checa atualizações no boot (10s) e
  de 60 em 60s quando ocioso (`performAutoUpdate`, `autoDownload=false`); o
  renderer (`vendas.html`) escuta `natal:updateAvailable`/`natal:updateProgress`
  e abre o modal "Nova versão disponível" com botão "Instalar agora"
  (`instalarAtualizacao` → IPC `natal:updateApp`, que baixa e reinstala
  sozinho; "Agora não" dispara `dispensarUpdate` e não re-abre neste boot).
  Feed do update = GitHub releases (`Sploit23/Kiosk_Maxx`, tag `v*` →
  release.yml). Nova versão só é oferecida se a tag > installed `app.getVersion()`.

## Caveats conhecidos

- **Atualização nunca é automática:** o PDV **só instala quando o operador
  clica** no modal. Primeira instalação é manual (baixar o NSIS do release).
- **Senha admin do portal** tem hash embutido em `backend/config.php`; usuários
  têm senha em texto puro dentro de `backend/data/app.json`.