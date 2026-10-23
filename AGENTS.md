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
- **Importador de cartão:** `tools/pegar-fotos/` (Pegar_Fotos vendorizado, Python
  → `Natal_Foto_Import.exe` no CI) roda **headless** junto do Electron (porta
  **8099** + descoberta UDP **50000**), recebe os lotes do cartão do fotógrafo e
  grava em `<photosFolder>\_cartao`; o sidecar Node transforma cada lote em
  sessão PRONTA.

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
| GET | `/api/health` | `{ ok, pdv, time, ribbon, filaPortal, build, pid }` |
| GET | `/api/printer/status` | Status real da ASK-400 (proxy p/ Java: papel 10x15/15x20, connected, lastError) |
| GET | `/api/config` | Config da máquina + ribbon |
| POST | `/api/config` | Salva config da máquina |
| GET | `/api/import/status` | Status do importador do cartão (proxy do `:8099/api/status`) + pasta/flag + mapa `lote → sessão` |
| POST | `/api/import/sincronizar` | Força o importador a procurar o cartão agora (proxy do `:8099/api/sync-now`) |
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
| POST | `/api/pedidos/:id/pagamento` | Registra pagamento → `PAGO`, sessão `VENDIDA`. Exige pedido `AGUARDANDO` e soma dos pagamentos == total |
| POST | `/api/pedidos/:id/impressao/:filename` | Upload da imagem final de impressão (fila) |
| POST | `/api/pedidos/:id/imprimir` | Dispara pipeline de impressão (exige `PAGO`, fotos não vazia, lock anti-impressão dupla) |
| PUT | `/api/pedidos/:id` | Persiste correções pós-pagamento feitas no PDV (total, pagamentos/meio, itens/produtos, desconto, status `CANCELADO`, `codigoDigital` do envio digital) |
| POST | `/api/galeria/upload/:codigo/:seq` | Upload do JPEG final do envio digital (pose única) — grava em disco e tenta FTP |
| POST | `/api/galeria/finalizar/:codigo` | Fecha o envio digital `{total, pedidoId}` → libera o manifesto (sobe por último) |
| GET | `/api/galeria/fila` | Estado dos envios digitais `{itens, pendentes, fotosPendentes, urlBase}` |
| POST | `/api/galeria/fila/sincronizar` | Força o reenvio das galerias pendentes (`{codigo}` opcional = só aquele código; worker também roda a cada 60s) |
| GET | `/api/pdv/caixa` | Estado do caixa atual |
| GET | `/api/pdv/caixas` | Histórico de caixas fechados (persistido em `caixas.json`, ordenado do mais recente primeiro) |
| POST | `/api/pdv/caixa/abrir` | Abre caixa (`CX-...`) |
| POST | `/api/pdv/caixa/fechar` | Fecha caixa (conciliação: totalVendido, totalPorMeio, meiosDeclarados, totalRecebido, diferenca, valorEnvelope, saldoRestante, fechadoPor, numero) e arquiva no histórico |
| GET | `/api/portal/fila` | Fila de envio ao portal: `{ itens, total, enviados, enviadosAt }` (`itens` **incluem `payload`**; `enviadosAt` = quando cada chave foi confirmada) |
| POST | `/api/portal/fila` | Enfileira item `{tipo: vendas\|pedido\|auditoria, chave, payload}` (dedup por tipo+chave → `criado`; se o hash do payload já foi confirmado → `inalterado` e não enfileira) |
| POST | `/api/portal/fila/confirmar` | Confirma envio `{ids, status}` → remove e grava `{em, hash}` em `enviados-portal.json` |
| POST | `/api/portal/fila/erro` | Registra falha `{id, erro}` → `tentativas++`, `ultimoErro` |
| POST | `/api/portal/fila/limpar` | Limpa a fila (**exige senha**: body `{senha}`, default `HCss221087`, env `NATAL_LIMPEZA_SENHA`) |
| POST | `/api/portal/enviados/limpar` | Limpa o registro de enviados (permite reenviar do zero) |
| GET | `/api/cache/portal` | Cache offline `{precos, catalogo, equipe, credenciais}` (credenciais só como hash sha256) |
| POST | `/api/cache/portal` | Salva/atualiza o cache (`{precos}\|{catalogo}\|{equipe}\|{credenciais}`) |
| POST | `/api/cache/portal/conferir` | Valida login offline `{usuario, senha}` contra o cache TOFU → `{ ok }` |
| OPTIONS | qualquer | CORS preflight |

**Eventos SSE emitidos:** `sessao:criada`, `sessao:status`, `sessao:concluida`,
`pedido:criado`, `pedido:pago`, `print-start`, `printer:progress`,
`print-complete`, `caixa:aberto`, `caixa:fechado`, `galeria:enviado`. Cliente:
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
| `precos` | `lojaId` | Catálogo + preços da loja (fonte de verdade do PDV): `{ ok, lojaId, precos, catalogo }` — `precos` = mapa chave→valor (compat. PDVs antigos), `catalogo` = `{ tamanhos, extras, combos }` estruturado salvo no admin ou os defaults oficiais (`data/precos.json`) |
| `kiosk.seed` | `kioskCode`, `nome` (+ `pdvNome`, `machineId`) | Wizard de 1º uso: grava RASCUNHO do nome do local em `db.pendentes[kioskCode]` (não cria loja — senão o `kiosk.pair` casaria cedo demais) → `{ ok, pendente }`; loja já existente com o código → `{ ok, jaRegistrado }`; `DADOS_INCOMPLETOS`/`NOME_INVALIDO` |
| `kiosk.pair` | `kioskCode` (+ `pdvNome`, `machineId`; legado `lojaId`+`pairingCode`) | Emparelha o kiosk com a loja: resolve a loja pelo código exibido NA TELA do PDV, registra `pareamento` e bloqueia máquina já usada por outra loja (`KIOSK_NAO_EMPARELELHADO`, `MAQUINA_JA_EMPARELHADA`) → `{ loja, pareamento }` |
| `vendas.push` | `lojaId`, `machineId`, `data` (YYYY-MM-DD) + snapshot | PDV → portal: snapshot diário de vendas por loja. Exige `machineId` == `pareamento.machineId` da loja (`LOJA_NAO_EMPARELELHADA` 403, com delay anti-bruteforce). Upsert em `data/vendas.json` por loja+data: `lojaNome`, `pdvNome`, `totalVendido`, `pedidos`, `sessoesCriadas`, `sessoesVendidas`, `taxacombo`, `ribbonRestante`, `papel10x15`/`papel15x20` (papel REAL da impressora via checkPrinter, `null` se sem resposta), `meios {dinheiro,debito,credito,pix}`, `ultimaVenda`, `caixa {numero,aberto}`, `enviadoEm` |
| `pedido.push` | `lojaId`, `machineId` + `pedido` (objeto) | PDV → portal: pedido completo, **idempotente pelo `pedido.id`** (reenvio só sobrescreve). Exige máquina pareada (mesmo bloqueio do `vendas.push`). Normaliza `itens [{tipo,produtoId,label,qtd,unidades,precoUnit,subtotal}]` — `precoUnit`/`subtotal` podem ser **negativos** (linha de ajuste de desconto/diferença) —, `pagamentos [{meio,forma,valor,parcelas}]`, `pagoEm` (hora real do pagamento), `sessoes`, `desconto`, `caixaId`, `origemPedidoId`, `guiaImpressa`, `unidadesTotal` (somada dos itens de tamanho). Alimenta Pedidos/Ranking/DRE. Persistido em `data/pedidos.json` |
| `auditoria.push` | `lojaId`, `machineId` + `uso` (objeto) | PDV → portal: uso de senha master (perda, desconto/cancelamento, cobrança de diferença), **idempotente pelo `uso.id`**. Campos: `titulo`, `operador`, `motivo`, `data`, `criadoEm`, `pedidoContexto`, `pedidoGeradoId`. Persistido em `data/auditoria.json` (a aba "Auditoria" foi removida do admin; os dados continuam disponíveis via `auditoria.list`) |

**Admin (token):** `admin.login` (valida senha SHA-256 → `{ token, expiraEm }`),
`lojas.list` (lojas com status de conexão: `online`/`ultimaConexao`/
`conexaoDelta` derivados do `enviadoEm` mais recente em `vendas.json`/
`pedidos.json`/`auditoria.json` — ONLINE se última conexão ≤ 10 min,
`ONLINE_JANELA_SEG` no `api.php`; o PDV manda snapshot a cada 5 min, então
esse campo é o heartbeat do kiosk), `lojas.save` (**2 caminhos**: com
`id`+`nome` = cadastro/edição manual normal; só `kioskCode` = wizard do PDV —
resolve nome/pdv/máquina no rascunho `pendentes`, gera `id` por `slugLoja()`
(com sufixo `-2`…), grava `pareamento` na hora e apaga o rascunho →
`{ ok, loja, criada:true }`; sem rascunho → `RASCUNHO_NAO_ENCONTRADO` 404),
`lojas.delete` (remove a loja e, em cascata, usuários/vendas/pedidos/auditoria/
despesas daquela loja — **catálogo e preços NÃO são apagados**),
`lojas.limparOrfaos` (remove os órfãos de lojas já excluídas; idempotente;
preserva `precos.json`), `usuarios.list`, `usuarios.save`,
`usuarios.delete`, `precos.save` (salva `{ lojaId, precos }` **ou**
`{ lojaId, catalogo }` em `data/precos.json`; com `catalogo` valida
`sanitizarCatalogo()` — exige os tamanhos `10x15` e `15x20`, deriva o mapa flat
das chaves oficiais e grava também `__catalogo`; catálogo inválido →
`CATALOGO_INVALIDO`; sem catálogo, valores vazios resetam para os defaults),
`precos.list` (overlay bruto + `defaults` + `catalogoDefault` — admin/backup),
`vendas.resumo` (todos os snapshots de `data/vendas.json`, data desc → lojaId asc →
`{ ok, vendas }`), `pedido.list` (pedidos consolidados de `data/pedidos.json`,
filtros `lojaId`/`dataIni`/`dataFim`/`q`/`status` — `status` é case-insensitive,
sort criadoEm desc →
`{ ok, pedidos, total, totalLiquido }` − exclui status `cancelado` do
totalLiquido), `auditoria.list` (usos de `data/auditoria.json`, filtros
`lojaId`/`dataIni`/`dataFim`, sort criadoEm desc → `{ ok, auditoria, usos }`),
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
`ribbonCritico` (un., 100) — limite usado pela tela Estoque no status do kit —
e as taxas das maquininhas `taxaCredito`/`taxaDebito`/`taxaPix` (%) aplicadas
sobre os recebimentos de cada forma no Financeiro (dinheiro não tem taxa).

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
│   ├── utils/               # imageUtils, pricing, printUtils (300 DPI), thumbnailUtils, qr
│   └── vendor/qrcode.js     # Gerador de QR offline (MIT, Kazuhiko Arase)
├── sidecar/
│   └── natal-core.cjs       # Backend local (Node http, 0 deps)
├── backend/
│   ├── api.php              # API cloud single-file
│   ├── config.php           # APP_DATA_DIR + ADMIN_SENHA_SHA
│   ├── admin.html           # Portal de gestão (SPA vanilla JS)
│   ├── natal/               # Página pública /natal (código → fotos digitais)
│   │   ├── index.php        # consulta do código + downloads (sem cache)
│   │   └── fotos/           # JPEGs <CODIGO>_<n>.jpg + manifesto <CODIGO>.json
│   ├── publish.ps1          # Deploy FTP (HostGator) — portal + /natal
│   └── data/                # JSONs (bloqueado por .htaccess)
├── impressora/
│   ├── native_libs/picgo-ask400/   # DLLs da ASK-400 + perfil ICC
│   └── status_ok/                   # Sidecar Java (build/, build.ps1, RESUMO.md)
├── public/overlays/         # PNGs de overlay (bolinha, 10x15, 15x20)
├── tools/pegar-fotos/       # Importador de cartão (fonte Python + spec PyInstaller)
│   └── dist/Natal_Foto_Import.exe  # gerado por build:importador → resources/importador
├── build/installer.nsh      # regras de firewall do importador (NSIS elevado)
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
  guiaImpressa, impressoEm?, codigoDigital? }`
- **Caixa** (`database/caixa.json`): `{ id: 'CX-*', operador, valorInicial,
  abertoEm, fechadoEm?, pedidos: [], meios: {}, totalVendido?, totalPorMeio?,
  meiosDeclarados?, totalRecebido?, diferenca?, valorEnvelope?, saldoRestante?,
  fechadoPor?, numero?, observacoes? }`
- **Histórico de caixas** (`database/caixas.json`): array de caixas fechados
  (campos do fechamento acima), persistido a cada `caixa:fechado` e servido por
  `GET /api/pdv/caixas` (mais recente primeiro).
- **Contadores:** `counter.txt` (sessões), `ribbon-counter.txt` (ribbon da
  impressora, default 400), `config.json` (config da máquina).
- **Fila de envio ao portal (`database/fila-portal.json`):** array de itens
  `{id, tipo: vendas|pedido|auditoria, chave, payload, tentativas, ultimoErro,
  criadoEm, atualizadoEm}` — o `payload` é o **corpo completo** guardado no
  enqueue; o drain reenvia exatamente ele. Dedup por `tipo`+`chave`.
- **Enviados (`database/enviados-portal.json`):** objeto
  `tipo:chave → { em, hash }` (hash sha256 do payload confirmado), gravado no
  confirmar — evita reenvio duplicado, mas **permite reenviar quando o payload
  mudou** (ex.: pedido cancelado depois de pago). Entradas antigas em `ms`
  (número) continuam válidas e são tratadas como hash desconhecido.
- **Cache offline (`database/cache-portal.json`):**
  `{ precos, catalogo, equipe, credenciais, atualizadoEm }`; credenciais são
  `{ usuario: {hash: sha256(senha), atualizadoEm} }` (nunca senha em claro).
- **Envio digital (`galeria/<CODIGO>/`):** fila durável do produto
  `foto-digital`. `meta.json` = `{ codigo, criadoEm, pedidoId, total,
  finalizadoEm?, manifestoEnviadoEm?, fotos: [{seq, enviadoEm, erro}],
  tentativas, ultimoErro, atualizadoEm }` + os JPEGs `<seq>.jpg`. O sidecar sobe
  por FTP como `<CODIGO>_<seq>.jpg` para `/public_html/natal/fotos` e, **por
  último**, o manifesto `<CODIGO>.json` — a página pública `/natal` só lista as
  fotos quando o manifesto existe (nunca publica venda pela metade). Worker
  reenvia pendentes a cada 60s e no boot.

**Portal PHP — `backend/data/app.json`:**

- **Loja:** `{ id, nome, pdv, ativo, kioskCode?, pairingCode?, pareamento? }` —
  `pareamento = { pdvNome, machineId, emparelhadoEm }` gravado por `kiosk.pair`.
  O `kioskCode` (8 chars, exibido na TELA do PDV) é digitado pelo admin na
  loja — é o que ata a máquina física à loja; ele é único por loja
  (`CODIGO_EM_USO`). `pairingCode` é o fluxo legado (código gerado no admin).
- **Rascunho do wizard (`app.json` → `pendentes`):** `pendentes[kioskCode] =
  { kioskCode, nome, pdvNome, machineId, criadoEm, atualizadoEm }` — nome do
  local enviado pelo PDV via `kiosk.seed` antes da loja existir; consumido
  (apagado) pelo `lojas.save` só-com-código ou manual com o mesmo código.
- **Usuário:** `{ id: 'u-*', lojaId, usuario, nome, funcao:
  vendedor|fotografo|admin|gerente, senha (texto puro no arquivo), ativo }`
- **`admin.json`:** `{ hash }` (senha admin SHA-256, default = hash do valor em
  `backend/config.php`), **`tokens.json`:** `{ token: expiraEm }`.
- **Despesas (`data/despesas.json`):** array de despesas lançadas manualmente
  pela gestão (não vêm do PDV): `{ id: 'DESP-*', lojaId, data
  (YYYY-MM-DD), categoria, descricao, valor, criadoEm }`. Administrado dentro
  da tela "Financeiro" (`admin.html`, `despesas.list/save/delete`).
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
  (`pedido.push`), em ordem de chegada. Alimenta as telas "Financeiro"
  (resultado, DRE e despesas), "Ranking" (agrega por operador/loja) e o
  resultado do período (`pedido.list`).
- **Auditoria (`data/auditoria.json`):** array de usos de senha master por
  `uso.id` (`auditoria.push`). Campos: `id`, `lojaId`, `lojaNome`, `pdvNome`,
  `machineId`, `data`, `criadoEm`, `titulo` (perda/desconto/cancelamento/
  cobrança de diferença), `operador`, `motivo`, `pedidoContexto`,
  `pedidoGeradoId`, `enviadoEm`. A aba "Auditoria" foi removida do admin; os
  dados continuam disponíveis via `auditoria.list`.
- **Parâmetros (`data/parametros.json`):** parâmetros globais da gestão
  (`parametros.save`), defaults em `PARAMS_DEFAULT` do `api.php` — ver sessão
  "Admin (token)" acima.

## Configurações

- **`shared/config.js`** — fonte única: `serverUrl` (default
  `http://localhost:9877`), `portalApiUrl` (`https://maxxfoto.com.br/natalcontroler/api.php`),
  `galeriaNatalUrl` (`https://maxxfoto.com.br/natal`),
  `lojaId` (`teste`), `lojaNome`, `pairingCode`, `pdvNome`, formatos de foto,
  produtos, pricing, overlays, estados, meios de pagamento (`dinheiro`, `pix`,
  `debito`, `credito`) e timers.
- **Catálogo — fonte de verdade no portal:** o PDV (`vendas.html`) busca
  `portalApi.precos()` no boot, a cada 60s e a cada emparelhamento e reconstrói o
  catálogo local (`TAMANHOS`/`EXTRAS`/`COMBOS`) com o `catalogo` estruturado
  devolvido. O admin edita/cria/exclui produtos em "Catálogo de
  produtos" (tela `#screen-precos`: 3 listas + modal "novo"; `precos.save` com
  `{catalogo}`). O seletor tem **Padrão — todas as lojas**
  (`precos.json['__global']`, herdado por lojas novas e por lojas sem ajuste) e
  ajustes opcionais por loja; a resolução é loja → global → `CATALOGO_DEFAULT`.
  Cada **tamanho** tem um `modelo` — formato físico de impressão
  (`10x15`/`15x20`/`bolinha`/`polaroide`) — que manda na composição e no `media`
  do Java; `10x15` e `15x20` são obrigatórios (base da impressão/pareamento de
  ribbon) e `unidades` de ribbon é derivado do modelo (não editável). `extras`
  com `oculto:true` (Item Encarte, Porta-cartão postal) só aparecem dentro de
  combos. O PDV aplica o catálogo em `aplicarCatalogoPortal()` (com assinatura
  para não re-renderizar à toa) e mapeia `modeloDe(t)`/`modeloProduto(id)` em
  tudo que depende de molde/`media` (`renderFrame`, `addToCart`,
  `iniciarImpressaoFotos`). `shared/config.js` `PRICING` é apenas o fallback
  offline (valores oficiais do evento). **Offline:** o último catálogo recebido é
  salvo no `cache-portal.json` (`POST /api/cache/portal {precos, catalogo}`) e
  reaplicado no próximo boot ("[precos] catálogo do cache local aplicado").
- **Envio digital (`foto-digital`)** — produto extra do PDV: a foto escolhida é
  composta em **10x15 pose única** (`composePrintImage({ key:'10x15', single:true })`)
  e sobe para a galeria por **código da venda** (6 chars, alfabeto sem ambíguos).
  O resumo mostra QR + código, o QR fica reabrível em **Pedidos** e a comanda
  térmica imprime o código. A página `backend/natal/index.php` (`/natal`) só
  lista as fotos depois do **manifesto**; antes disso mostra "aguarde" e o
  telefone (41) 3053-2223 (nota fixa: se não aparecer em até 8h, ligue).
  FTP: `FTP_DEFAULTS` no sidecar (`ftp.maxxfoto.com.br`,
  `arenacaptour@maxxfoto.com.br`, pasta `/public_html/natal/fotos`, URL
  `https://maxxfoto.com.br/natal`), sobrescritos por
  `NATAL_FTP_HOST/PORT/USER/PASS/FOLDER`, `NATAL_GALERIA_URL` ou pela config da
  máquina; a senha **nunca** vai ao renderer (`configPublica`). O upload nunca
  bloqueia a venda: falha → fila local (`galeria/<CODIGO>/`) + retry a cada 60s.
- **`electron-config.template.json`** — `renderServerUrl`, `serverUrl`,
  `thermalPrinterName`, `pdvNome` (`VENDA-01`), `portalApiUrl`, `lojaId`,
  `lojaNome`, `pairingCode` (código gerado no admin do portal; vazio = sem
  emparelhamento), `photosFolder` (pasta de fotos configurável pelo modal ⚙
  do PDV).
- **Identidade offline-first (PDV `vendas.html`)** — **a loja é definida NO
  APP**, pelo `⚙ Config` (`lojaId` + `lojaNome` gravados no `config.json` do
  sidecar e no `electron-config.json`); o portal **não define nem sobrescreve**
  a loja, só **autoriza a máquina**. `identidadeSync()`/`publicarIdentidade()`
  publicam `{machineId, lojaId, lojaNome, pdvNome}` em `window.portalIdentidade`
  e `portalApi.identidadeAtiva()` (→ `lojaIdAtivo()/machineIdAtivo()`) injeta
  esses campos em todo push (`vendas/pedido/auditoria.push`). `emparelharKiosk`
  só faz **seed** de `lojaId/lojaNome` quando vazios (1º boot) e grava
  `pareadoEm/pareadoLojaId`. No portal, `validarLojaPareada` resolve a loja
  pelo `machineId` enviado (compatível com lojaId divergente) e `lojaNomePush`
  usa o nome enviado pelo PDV.
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
- **Identidade resistente a perda de config (`natal-core.cjs`)** — `machineId`
  e `kioskCode` vivem no `config.json` da pasta de dados (dentro de
  `<photosFolder>\natal-app`), então apagar essa pasta/corromper o arquivo
  desemparelharia a máquina. Por isso o sidecar mantém um **backup fora da
  pasta de fotos** em `C:\ProgramData\MaxxNatal\kiosk-identity.json`
  (`IDENTITY_BACKUP_FILE`), regravado a cada `POST /api/config`; no boot, se o
  `config.json` vier sem `machineId`/`kioskCode`, a identidade (e loja salva no
  app) é restaurada do backup e reescrita no `config.json` — config existente
  sempre tem prioridade. O **`photosFolder` também é preservado**: se o
  `config.json` sumir (pasta apagada/movida), o boot usa o ponteiro
  `fotos-folder.txt` (`NATAL_PHOTOS_FOLDER`) em vez de zerar a config — antes
  disso o ponteiro era sobrescrito com vazio e a máquina parava de criar
  sessões, exigindo reconfigurar a pasta. `writeJson()` passou a ser
  **atômico** (`.tmp` +
  rename), evitando JSON truncado por queda de energia. Trocar de propósito
  continua sendo o botão "Gerar novo código" (`_forceIdentity`) ou o script
  `-Completo`. O portal autoriza push pelo `machineId` (o `kioskCode` é só a
  chave do `kiosk.pair`), então perder só o código não bloqueia a fila local —
  basta o admin colar o novo código na loja.
- **Wizard de 1º uso (PDV `vendas.html` + `admin.html`)** — assistente no
  overlay `#wizard-overlay` (funções `wz*`), mostrado **só quando a config não
  tem `lojaNome`** (e sem `window.kioskPair.ok`): 1) operador digita o **nome
  do local** (grava no sidecar e manda `kiosk.seed` → rascunho no portal,
  flag `wzSeedOk` = 1 envio/boot); 2) mostra o **código de pareamento** e
  espera o admin criar a loja em **Lojas → + Nova loja** (`modalNovaLoja`,
  só-com-código → `lojas.save`), que grava o `pareamento` na hora; 3)
  pareamento ok → avisa "cadastre os funcionários" (mensagem **também no
  portal**: `modalPareamentoConcluido`); 4) equipe visível → login normal →
  abertura de caixa. "Pular" fecha só nesta sessão; sem rascunho no portal o
  admin cai no form manual (`RASCUNHO_NAO_ENCONTRADO` → `modalLoja(null)`).
- **Sync de vendas → portal (`vendas.html`)** — o PDV calcula o snapshot do dia
  (`enviarSnapshotVendas` em `vendas.html`; `portalApi.vendasPush` em
  `shared/api/portalApi.js`) e envia via `vendas.push`: 4s após o boot, 3s após
  emparelhar, com debounce em `pedido:pago`/`caixa:aberto`/`caixa:fechado`
  (SSE) e `setInterval` de 5 min. Só envia se `window.kioskPair` existir (loja
  canônica + `machineId`). Snapshot do dia = pedidos `PAGO`, total de hoje,
  sessões criadas/vendidas de hoje, taxa de combos %, ribbon restante (contador
  interno) + papel real da impressora (10x15/15x20 via `checkPrinter`), último
  pagamento e caixa atual. Offline/falha: o item vai para a **fila durável**
  (`enqueuePortal` → `fila-portal.json`) e é drenado quando a rede volta —
  ver próximo bloco.
- **Fila de envio / drain (`vendas.html`)** — `drenarFilaPortal()` percorre
  `GET /api/portal/fila` (itens **com `payload`**), manda cada um via
  `portalApi.post(action, payload)` e confirma (`/api/portal/fila/confirmar`)
  ou registra erro (`/api/portal/fila/erro`, com `ultimoErro`). Gatilhos:
  ~4s após o boot, `setInterval` de 5 min, eventos SSE, botão "Sincronizar
  agora" do ⚙ e logo após venda/caixa. `enviados-portal.json` impede reenvio
  do que já foi confirmado **com o mesmo hash** (mudou → reenvia; é assim que
  cancelamento/correção de um pedido já enviado chega ao portal); para reenviar
  de propósito use "Limpar fila de envio" (⚙,
  senha `HCss221087`) ou `POST /api/portal/enviados/limpar`. A topbar **não**
  mostra mais pendências (`#sync-chip` removido); o estado aparece só no ⚙
  Config → aba **Sincronizar** (pendentes / sincronizando).
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
  no boot reidrata o log local como já enviado (`_portalEnviado: true`). Se o
  portal estiver fora, o item entra na fila durável e sai quando a rede volta.
- **Login offline (TOFU)** — o primeiro login bem-sucedido de um usuário salva
  `{usuario: senha}` no cache (`POST /api/cache/portal {credenciais}` → hash
  sha256, nunca em claro); no offline o PDV valida contra esse hash
  (`POST /api/cache/portal/conferir`). Equipe, preços e catálogo também são cacheados no
  sucesso e reaplicados quando o portal não responde.
- **Config da máquina (sidecar)** — `%APPDATA%\natal-app\database\config.json`
  guarda `{ pdvNome, photosFolder, thermalPrinterName, machineId, lojaId,
  lojaNome, pairingCode, importFolder, importSessoes }` via `GET/POST
  /api/config`; a UI salva também no `electron-config.json`. `importFolder`
  vazio = `<photosFolder>\_cartao` (valor efetivo exposto por `GET /api/config`
  como `importFolder`, e o custom como `importFolderCustom`); `importSessoes`
  (default `true`) liga/desliga a criação de sessões no sidecar.
- **Botão ⚙ Config** (`vendas.html`) — modal `showConfigModal(tab)` com **3 abas**:
  **Sincronizar** (aberta por padrão, qualquer operador) = painel "Sincronização
  com o portal" (pendentes, "Sincronizar agora", "Limpar fila de envio") +
  painel "Envio digital" com um botão **Sincronizar** por código pendente (força
  o upload na hora em que a internet volta; o worker de 60s continua de
  fallback); **💳 Cartão** (qualquer operador, `data-cfg-tab="card"`) = estado do
  importador, **outro PC da rede** (`peer`: conectado com nome/IP + status, ou
  "nenhum outro PC encontrado"), lotes recebidos (`lote → sessão`), "Procurar
  fotos agora" (`POST /api/import/sincronizar`), "Abrir pasta" (IPC
  `natal:openPath`) e o toggle **Criar sessões das fotos recebidas neste PC**
  (`importSessoes`); o chip da topbar também mostra "outro PC conectado" quando
  o PDV está ocioso (`peer.found`). Na **tela de login** (PC que só recebe, sem
  operador logado) a pílula `#login-peer` mostra o mesmo estado e é **clicável**:
  abre o overlay `#receive-overlay` (`abrirRecebimento`/`renderRecebimento`),
  um monitor ao vivo com peer + progresso (baixando/copiando) + últimas sessões,
  atualizado a cada 2,5s via `/api/import/status` + `/api/sessoes`;
  **🔒 Sistema** (exige senha **`8694`**, `SENHA_CFG_SISTEMA`, digitada
  num campo dentro do próprio modal — `#cfg-senha-box`; **nunca** usar
  `window.prompt`, que o Electron não implementa e lança erro) = pasta de fotos
  nativa (IPC `natal:selectFolder` →
  `dialog.showOpenDialog`), pasta dos lotes do cartão, logo do shopping, status
  real da impressora (10x15/15x20, connected, lastError), fila de impressão,
  "Loja desta máquina" (`lojaId`/`lojaNome`), emparelhamento/kioskCode,
  versão/atualização, manutenção ("Limpar dados") e o botão **Salvar** (grava
  nos dois lugares; se a pasta de fotos/lotes mudar, o main reinicia o
  importador via IPC `natal:restartImporter`). O desbloqueio vale só enquanto o
  modal está aberto. As seções são marcadas com `data-cfg-sec="sync|card|system"`
  e as abas com `data-cfg-tab`. Entradas de valor e senha usam os modais
  `askValor()` / `askSenhaTexto()` (o Electron não suporta `window.prompt`; usos
  antigos de prompt foram convertidos).
- **Importador de fotos do cartão** — `electron-main.cjs` sobe
  `resources/importador/Natal_Foto_Import.exe --headless` (dev:
  `tools/pegar-fotos/dist/Natal_Foto_Import/Natal_Foto_Import.exe`, com fallback
  para o exe onefile antigo / `python tools/pegar-fotos/app.py`) com `--root
  <importFolder> --port 8099 --no-firewall --config
  <userData>\importador-config.json --log <userData>\logs\importador.log`.
  O PyInstaller builda em **onedir + UPX off** (spec
  `Natal_Foto_Import.spec`): inicia em ~1s, não extrai em pasta temporária e
  reduz falso positivo de antivírus (onefile + UPX era morto antes de abrir a
  porta em PCs lentos). O main **não desiste mais** do importador: espera até
  45s no cold start, adota instância órfã na mesma pasta, mata a instância
  presa na trava `Global\NatalFotoImport` e relança, faz backoff (3–20s) em vez
  de parar após 5 tentativas e tem **watchdog de 30s** (`startImporterWatchdog`)
  que religa se ele cair depois do boot; pasta de fotos indisponível
  (HD/rede) gera erro claro e nova tentativa em 30s. Eventos do importador vão
  para `<userData>\logs\main.log` (append, rotaciona em 2 MB) e a aba ⚙ →
  Cartão mostra o motivo real quando está parado (`natal:importerInfo` em
  `preload.cjs`), com botões **Reiniciar importador** e **Abrir log**
  (`natal:openImporterLog`); o monitor de recebimento do login também tem
  "Reiniciar importador". Para no `will-quit`. O app NÃO pede UAC: as regras de
  firewall (TCP 8099 + UDP 50000 para o exe do importador) são criadas pelo
  instalador NSIS elevado (`build/installer.nsh`, `perMachine: true`).
- **Importação de lotes do cartão** (`natal-core.cjs`) — regra da drop zone:
  **1 subpasta = 1 sessão**, tanto em `photosFolder` (programa externo) quanto em
  `importFolder` (importador embutido). No `importFolder`, a subpasta só é
  importada quando existe o marcador **`.natal_done`** (o importador grava
  depois de copiar tudo) e ≥1 `*.jpg|*.jpeg|*.png`; lote só-RAW/vídeo é
  ignorado. O watcher roda a cada 900ms (`PHOTOS_POLL_MS`) e exige 3s de
  estabilidade (`PHOTOS_SETTLE_MS`); cria a sessão `NATAL-XXXXX`, copia as fotos
  (original + preview normalizado `.jpg`), marca `PRONTA` automaticamente e
  registra em `pasta-importadas.json` (chave = caminho absoluto + snapshot do
  conteúdo, para não reimportar). Na raiz de `photosFolder` são ignoradas as
  pastas `importadas`, a própria pasta do cartão e pastas ocultas (`.tmp_*`).
  `criadaEm` da sessão = o instante em que a subpasta foi criada (birthtime;
  fallback: criação da 1ª foto), e `prontaEm` = instante do import. Arquivos <
  1KB ou com tail `.part/.tmp/.crdownload/.download` são ignorados (cópia pela
  metade). Troca de pasta na config vale na hora.
- **Financeiro (admin, `admin.html`)** — tela `#screen-financeiro` (`renderFinanc`):
  filtros por mês/intervalo e "Todo o período", cards (faturamento, taxas,
  despesas & custos, líquido), gráfico de barras divergentes "Líquido por loja"
  (com tooltip), tabela por loja, card de taxas Crédito/Débito/PIX editáveis
  via `parametros.save` e CRUD de despesas do período. A receita por loja usa
  pedidos consolidados (`pago`/`impresso`) e cai para o snapshot diário **só
  nas lojas sem pedido no período** (não conta duas vezes). Líquido =
  faturamento − taxas − ribbon − comissões − despesas. A antiga tela
  "Despesas & Taxas" foi absorvida (item de nav removido).
- **`vite.config.js`** — alias `@shared` → `./shared`, dedupe de React, porta
  de dev 5173.

## Comandos

- `npm start` / `npm run electron:dev` — Vite (5173) + Electron (PDV real)
- `npm run dev` — só Vite
- `npm run build` — build Vite (main + pdv) para `dist/`
- `npm run build:importador` — compila `tools/pegar-fotos/dist/Natal_Foto_Import.exe`
  (requer Python 3 + `pip install pyinstaller`; o CI usa Python 3.12)
- `npm run build:win` — compila o importador + build Vite + empacotador (NSIS elevado)
- `npm run release` — build completo + publish GitHub (release)
- `npm run lint` — ESLint
- `backend/publish.ps1` — deploy FTP do portal PHP **+ página `/natal`** (credenciais em `../../credencial.txt`)
- `tools/limpar-dados-pdv.ps1` — zera os dados de teste do PDV (sessões, pedidos, caixa, fila de impressão, auditoria, contador de ribbon) com backup automático. Acha a pasta de dados sozinho (API `:9877/api/config` → ponteiro `%APPDATA%\natal-kiosk\database\fotos-folder.txt` → `electron-config.json` → `config.json`) e **recusa rodar com o app aberto** (o sidecar reescreve os arquivos em memória). Flags: `-DryRun` (só mostra), `-Completo` (apaga `database\config.json` + o backup `C:\ProgramData\MaxxNatal\kiosk-identity.json` → novo `machineId`/`kioskCode`, exigindo re-emparelhamento no portal), `-Forcar`. Depois de limpar é preciso **abrir um novo caixa** no PDV.

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
- **Portal publicado pode estar defasado:** `backend/api.php` é editado aqui e
  só vai ao ar em `backend/publish.ps1`. Antes de caçar bug no PDV por erro de
  push estranho (`LOJA_INVALIDA`/`LOJA_NAO_EMPARELELHADA`), conferir se a versão
  em `maxxfoto.com.br` tem as mudanças novas (autorização por `machineId`,
  `lojaNome`).
- **Senhas em claro no código:** fallback de login em `vendas.html`
  (`FALLBACK_USERS`, senha `0000`) e `SENHA_MASTER_PDV = '1234'` (senha master
  de desconto/perda). O cache offline (TOFU) guarda só sha256.
- **Limpar a fila de envio exige senha** (`HCss221087`) justamente para o
  operador não apagar pendências sem querer.
- **`window.prompt` não existe no Electron** (lança "prompt() is not supported"
  e a ação morre em silêncio). Toda entrada de texto/valor usa `openModal()` +
  `askValor()` / `askSenhaTexto()`; `alert`/`confirm` funcionam (`window.confirm`
  é usado nas confirmações).
- **`php` CLI não existe nesta máquina** — lint/validação do `backend/api.php`
  é manual (na web ou com PHP instalado).