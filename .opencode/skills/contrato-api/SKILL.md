---
name: contrato-api
description: Contrato exato da API do portal (backend/api.php) usado pelo PDV - payload, IDs, status e pareamento. Use SEMPRE que for alterar ou depurar envios PDV -> portal (vendas.push, pedido.push, auditoria.push, kiosk.pair).
---

# Contrato API PDV → Portal

O portal é `backend/api.php` (PHP single-file, dados em `backend/data/*.json`, sem SQL).
O PDV fala com **dois** backends: sidecar local (`sidecar/natal-core.cjs`, porta 9877) e portal cloud (`shared/api/portalApi.js` → `?action=`).

## Regras de identidade (causa #1 de erro)

**Modelo offline-first (PDV vanilla `vendas.html`, produção):**

- A **LOJA é definida NO APP** (`⚙ Config` → `lojaId` + `lojaNome` gravados em
  `%APPDATA%\natal-app\database\config.json` via `POST /api/config`). O portal
  **não define nem sobrescreve** a loja — ele só **autoriza a MÁQUINA**.
- `machineId`/`kioskCode` são gerados no 1º boot e persistidos no sidecar
  (`resolverIdentidade`, `vendas.html`); o admin digita o `kioskCode` no portal.
- `identidadeSync()` (`vendas.html`) = `{machineId, lojaId, lojaNome, pdvNome}`
  a partir do sidecar (não depende de `window.kioskPair`, que é memória).
  `publicarIdentidade()` publica em `window.portalIdentidade`.
- `portalApi.identidadeAtiva()` (`shared/api/portalApi.js`) lê, nesta ordem:
  `window.portalIdentidade` → `window.kioskPair.ok` → default `config.lojaId`.
  `lojaIdAtivo()`/`machineIdAtivo()` derivam dela; **todo** push
  (`vendasPush`/`pedidoPush`/`auditoriaPush`) injeta `lojaId`, `lojaNome` e
  `machineId` no corpo.
- Seed no pareamento: `emparelharKiosk` grava `pareadoEm`/`pareadoLojaId` e
  **só preenche** `lojaId`/`lojaNome` quando estão vazios (1º boot). Nunca
  sobrescreve loja já definida no app.
- Portal autoriza por **machineId**: `validarLojaPareada` (`api.php:271`)
  procura a loja cujo `pareamento.machineId` casa com o enviado — o `lojaId`
  do kiosk pode divergir (loja recriada no portal). `lojaNomePush()` usa o
  nome enviado pelo PDV, senão o do cadastro.
- `machineId` vazio → `DADOS_INCOMPLETOS`; máquina sem loja pareada →
  `LOJA_NAO_EMPARELELHADA` (403, delay anti-bruteforce).

**Modelo legado (React `src/App.jsx` + `shared/api/portalSync.js`):** identidade
vinda só de `window.kioskPair` (`par()`), sem fila persistente — ver
`sync-debug`. Erro de pair pode sobrescrever `window.kioskPair` mesmo com
`res.ok === false` (`src/App.jsx:77`).

## Wizard de 1º uso (`kiosk.seed` + `lojas.save` só-com-código)

Fluxo de setup do kiosk novo (decisão: **gatilho = `cfg.lojaNome` vazio** no
PDV; máquina já configurada nunca vê o wizard):

1. **PDV** (`vendas.html`, overlay `#wizard-overlay`, funções `wz*`): operador
   digita o **nome do local** → `natalApi.saveConfig({lojaNome})` + então
   `portalApi.seed({kioskCode, nome, pdvNome, machineId})` →
   `kiosk.seed` (pública) grava rascunho em `db['pendentes'][kioskCode]`
   (`{kioskCode, nome, pdvNome, machineId, criadoEm, atualizadoEm}`).
   - Se a loja **já existe** com aquele código → `{ok, jaRegistrado:true}`
     (não cria rascunho; o pair normal resolve).
   - Não cria loja — senão o `kiosk.pair` casaria antes de o admin confirmar.
   - Flag `wzSeedOk` (módulo `vendas.html`) garante **1 seed por boot** e é
     também reenviada pelo hook de `KIOSK_NAO_EMPARELELHADO` em
     `emparelharKiosk`.
2. **Portal** (`admin.html`, `modalNovaLoja`): admin cola **só o código**
   (`lojas.save {kioskCode}` sem `id`/`nome`) → caminho código-only do
   `lojas.save` resolve nome/pdv/máquina no rascunho, gera
   `id = slugLoja(nome)` (`royal-plaza`, `-2`, `-3`…), grava
   `pareamento {pdvNome, machineId, emparelhadoEm}` na hora e **apaga o
   rascunho** → `{ok, loja, criada:true}` → `modalPareamentoConcluido`.
   - Sem rascunho → `RASCUNHO_NAO_ENCONTRADO` (404) → admin cai no form
     completo (caminho manual ID+Nome, que também consome o rascunho se o
     código bater).
   - Máquina já pareada em outra loja → `MAQUINA_JA_EMPARELHADA` (409).
3. **PDV** vê o pair ok (hook em `emparelharKiosk`: `_wz.etapa===2 → 3`) e
   espera a equipe (`portalApi.equipe()` a cada 5s) → etapa 4 → login normal
   → abertura de caixa. Mensagem "Pareamento concluído — cadastre os
   funcionários" aparece **nos dois lados** (PDV etapa 3 + modal no portal).
4. "Pular" (`#wz-skip`) fecha **só nesta sessão**; o loop de 30s do pair
   continua.

## Payload de `pedido.push`

Mapeamento canônico está em `shared/api/portalSync.js:32` (`montarPedidoPortal`). O sidecar entrega o pedido **cru**:

```
{
  id: p.id,                    // 'PED-*' do sidecar. NUNCA usar p.numero nem p._realId
  numero: p.numero,
  status: 'pago' | 'cancelado', // sidecar: AGUARDANDO|PAGO|IMPRESSO|CANCELADO → lowercase; só pago/cancelado são válidos no portal
  lojaId, caixaId,              // caixaId = o gravado NO pedido, não o caixa atual
  criadoEm: ISO, pagoEm: ISO,   // sidecar guarda em ms numéricos → converter new Date(ms).toISOString()
  itens: [{ tipo, produtoId, label, qtd, unidades, precoUnit, subtotal }],
  desconto: linha negativa em itens,
  pagamentos: [{ meio, valor, parcelas }],  // sidecar NÃO tem campo 'forma'; portal usa só 'meio'
  sessoes: [{ id, senha }],
}
```

- Meios conhecidos no portal: `dinheiro | debito | credito | pix` (`api.php:373`). `meio` vazio → pagamento descartado do Financeiro (`somaMeios`, `api.php:408`).
- **Dois mappers existem e divergem**: `vendas.html:2001` (usa `p._realId || p.id` sobre objeto **mapeado** por `mapearPedido`, `vendas.html:1637`) vs `portalSync.js:32` (objeto cru, `p.id`). Se `_realId` faltar, o portal recebe `id = numero` → **duplicidade** em `data/pedidos.json`. Ao tocar em qualquer um, manter os dois idênticos (ou melhor: unificar).
- Portal faz upsert por `pedido.id` (`api.php:682`).

## Payload de `vendas.push`

Snapshot do dia montado em `vendas.html` (`montarSnapshotVendas`/`enviarSnapshotVendas`):
pedidos `PAGO` de hoje, meios, sessões criadas/vendidas, taxa de combos, ribbon,
papel real 10x15/15x20, caixa. Campos extra do contrato:
`lojaId, lojaNome, machineId, pdvNome` (injetados por `portalApi.vendasPush`).
- `papel10x15/15x20 = null` quando impressora desconectada significa "sem dado" no admin (`api.php:655`).
- Upsert por `(lojaId, data)`; `enviadoEm` é carimbado pelo portal.

## Payload de `auditoria.push`

- Idempotente por `uso.id` (reenvio não duplica).
- `vendas.html` persiste auditoria no sidecar (`auditoria.json`) E empurra ao
  portal só quando aceito (`_portalEnviado`); o React (legado) só faz push
  direto — se o portal estiver fora, se perde.

## Fila durável de envio (PDV vanilla, só `vendas.html`)

Push que falha (`ok:false` ou `offline:true`) entra na fila do sidecar e é
reenviado depois — é isso que faz a venda do dia sair quando a internet volta.

- Arquivos em `%APPDATA%\natal-app\database\`: `fila-portal.json` (pendentes),
  `enviados-portal.json` (registro `tipo:chave → ms`, evita reenvio),
  `cache-portal.json` (cache).
- **Item da fila** `{id, tipo: 'vendas'|'pedido'|'auditoria', chave, payload, tentativas, ultimoErro, criadoEm, atualizadoEm}`
  — `payload` é o **corpo completo já montado** (guardado no enqueue; o drain
  reenvia exatamente isso, sem remontar).
- Endpoints sidecar: `GET /api/portal/fila` (`{itens, total, enviados}`),
  `POST /api/portal/fila` (dedup por `tipo`+`chave` → `criado`),
  `POST /api/portal/fila/confirmar {ids, status}` (remove e grava
  `enviados-portal.json`), `POST /api/portal/fila/erro {id, erro}`
  (incrementa `tentativas`, `ultimoErro`), `POST /api/portal/fila/limpar`
  (**exige senha** `HCss221087` ou env `NATAL_LIMPEZA_SENHA`),
  `POST /api/portal/enviados/limpar`, `GET|POST /api/cache/portal`,
  `POST /api/cache/portal/conferir {usuario, senha}` (valida TOFU por sha256).
  `/api/health` inclui `filaPortal`.
- Drain (`drenarFilaPortal` em `vendas.html`): pega `filaPortalListar()`
  (cada item **com `payload`**), manda via `portalApi.post(action, payload)`,
  `confirmar` no ok, `erro` na falha. Gatilhos: boot (~4s), 5 min, SSE
  (`portal:fila`), botão "Sincronizar agora" no ⚙, e após venda/caixa.
- **Cuidado histórico:** `filaPortalParaUI` já teve bug de omitir `payload` →
  drain enviava corpo vazio. Se mexer nela, garantir `payload` no retorno.

## Cache offline (PDV vanilla)

- `GET /api/cache/portal` guarda `{precos, equipe, credenciais}` (credenciais
  só como `{hash: sha256(senha), atualizadoEm}` — **nunca** em claro).
- No offline o PDV reaplica cache: `carregarPrecosPortal` → "[precos] catálogo
  do cache local aplicado"; `carregarEquipe` reidrata os cards do login.
- `tentarLogin` no offline valida a senha com `cachePortalConferir` (sha256)
  e com `senha === u.senha` dos usuários fallback locais.

## Transporte e erros

- `portalApi.post()` (`portalApi.js`): `POST {portalApiUrl}?action=...`,
  timeout 8s → `{ok:false, offline:true}`. HTTP ≥400 com JSON `ok:false` →
  repassa o JSON (`LOJA_INVALIDA`, `LOJA_NAO_EMPARELELHADA`,
  `DADOS_INCOMPLETOS`, `MAQUINA_JA_EMPARELHADA`, `CODIGO_EM_USO`...).
- Resposta do **sidecar** é `{success:...}`; exceto `/api/health` que é
  `{ok:true}`. Resposta do **portal** é `{ok:...}`.
- `natalApi.api()` (`natalApi.js`) **ignora HTTP status** e não tem timeout/retry.
- Ações do portal: públicas `health, login, equipe, precos, kiosk.seed,
  kiosk.pair, vendas.push, pedido.push, auditoria.push`; admin (token) as
  demais (`api.php` — procurar `ACAO_DESCONHECIDA`).
- **O portal publicado (maxxfoto.com.br) pode estar defasado** em relação ao
  `backend/api.php` deste repo (ex.: autorização por machineId, `lojaNome`) —
  em produção de erro estranho, conferir a versão publicada antes de caçar bug
  no PDV. Deploy: `backend/publish.ps1`.

## Ao alterar o contrato

1. Alterar `vendas.html` (montagem do payload), `shared/api/portalApi.js`
   (injeção de identidade) e `backend/api.php` juntos.
2. Conferir que `admin.html` lê o mesmo campo (ex.: id do pedido upsertado).
3. Rodar o checklist da skill `sync-debug`.
4. **`php` CLI não existe nesta máquina** → lint do `api.php` é manual/na web.
