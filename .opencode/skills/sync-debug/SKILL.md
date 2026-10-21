---
name: sync-debug
description: Checklist para depurar erros de sincronizacao PDV -> backend/portal (vendas que nao aparecem, LOJA_NAO_EMPARELELHADA, pedidos duplicados, abas do admin desatualizadas). Use quando o usuario reportar que dados nao chegam ao backend.
---

# Debug de sincronização PDV → Portal

Ordem de verificação. **PDV de produção = `vendas.html` (vanilla, offline-first)**;
`src/App.jsx` + `shared/api/portalSync.js` são o refactor React (modelo legado,
sem fila persistente) — se o problema for no React, ver o fim do arquivo.

## 0. Rápido (30s)

- [ ] Chip de sync na topbar do PDV: `● Sincronizado HH:MM` (ok) / `⛔ / ◌ N pendente(s)` (fila) / `⟳ sincronizando`.
- [ ] `GET http://127.0.0.1:9877/api/health` → `{ok:true, filaPortal:N}`.
- [ ] `GET http://127.0.0.1:9877/api/portal/fila` → `{total, itens:[{tipo,chave,tentativas,ultimoErro}], enviados}`.
- [ ] Tooltips/`ultimoErro` na fila: `LOJA_INVALIDA` (lojaId errado), `LOJA_NAO_EMPARELELHADA` (máquina sem par no portal), `DADOS_INCOMPLETOS` (machineId vazio), `offline`/timeout 8s (sem rede).
- [ ] Modal `⚙ Config` → painel "Sincronização com o portal" (status, "Sincronizar agora", "Limpar fila") e campos "Loja desta máquina".

## 1. Identidade / autorização (50% dos casos)

O portal **não define a loja**: ele só autoriza a **máquina**. Ver `contrato-api`.

- [ ] Sidecar `database/config.json` tem `machineId` + `kioskCode` (gerados no 1º boot)?
- [ ] `lojaId`/`lojaNome` preenchidos no app (`⚙`)? Vazio → seed pelo `emparelharKiosk` só na 1ª pareamento; depois disso nunca mais é sobrescrito.
- [ ] O `kioskCode` digitado no portal casa com o exibido na tela do PDV?
- [ ] O portal publicado é a versão nova? `validarLojaPareada` por **machineId** (resolve loja recriada no portal) e `lojaNomePush` são mudanças recentes do `backend/api.php`; se o `publish.ps1` não rodou, o portal em produção responde como o modelo antigo (`LOJA_INVALIDA`/`LOJA_NAO_EMPARELELHADA` com payload novo).
- [ ] `MAQUINA_JA_EMPARELELHADA`: o `machineId` desta máquina está em outra loja no portal → `tools/limpar-dados-pdv.ps1 -Completo` gera novo machineId e exige re-pareamento.
- [ ] `tools/limpar-dados-pdv.ps1` **apaga fila/cache/enviados** junto (tudo em `database/` exceto `config.json`) → após limpar, reabrir caixa e re-sincronizar.

## 2. Fila de envio / retry (só `vendas.html`)

- [ ] A venda/pagamento foi para `fila-portal.json`? Push falho (`offline:true` ou `ok:false`) é **enfileirado**, não perdido — `enqueuePortal`.
- [ ] Drain rodando? Gatilhos: boot ~4s, `setInterval` 5min, SSE `portal:fila`, botão "Sincronizar agora", pós-venda/caixa.
- [ ] Item fica preso com `tentativas` subindo e `ultimoErro` = `LOJA_INVALIDA` → corrigir identidade (seção 1); a fila **não** se auto-limpa.
- [ ] `enviados-portal.json` registra `tipo:chave` depois do ok → reenvio idempotente. Se precisar reenviar de propósito: `POST /api/portal/enviados/limpar` (ou ⚙ → "Limpar fila de envio", senha `HCss221087`).
- [ ] Drain precisa do `payload` no item — bug já ocorrido: `filaPortalParaUI` omitia `payload` → push com corpo vazio e `ok:false`.
- [ ] Timeout 8s por push: PHP lento (carrega JSONs inteiros) estoura e vira `offline:true` mascarando erro real.

## 3. Payload divergente (pedidos duplicados / totais errados)

- [ ] ID: o portal faz upsert por `pedido.id` (`PED-*` do sidecar, `p._realId`). Se virar `numero`, duplica em `data/pedidos.json`.
- [ ] Status: portal aceita só `pago|cancelado` (lowercase); `AGUARDANDO`/`IMPRESSO` não podem ir.
- [ ] `meio` vazio no pagamento → descartado de `somaMeios` → aparece como "Não informado".
- [ ] Datas: portal espera ISO (`criadoEm`/`pagoEm`); sidecar guarda ms.
- [ ] `caixaId` = o gravado no pedido, não o caixa atual.
- [ ] `lojaNome`/`pdvNome`/`machineId` presentes (injetados por `portalApi`).

## 4. Eventos SSE

- [ ] `shared/api/sse.js` multi-listener: cada chamada registra callback no mesmo `EventSource` (não reabre conexão).
- [ ] Escute `pedido:atualizado`? Se o React for refatorado, garantir que cancelamento (`PUT /api/pedidos/:id`) dispara novo push.
- [ ] SSE morto = erros seguidos → backoff; sem SSE o drain ainda roda por timer.

## 5. Ordem e abas do admin

- [ ] Snapshot antes dos pedidos: portal só reconcilia `meios` se a soma não fechar E os pedidos cobrirem o dia (`api.php`).
- [ ] Estoque/papel `null` quando a impressora Java (8080) não responde → admin mostra "sem dado".
- [ ] Abas do admin (`backend/admin.html`): Dashboard, Lojas, Financeiro, Despesas, Fluxo de Caixa, Estoque, Catálogo, Equipe, Ranking, Auditoria, Configurações — dados de `vendas.resumo`, `pedido.list`, `auditoria.list` (todos com `X-Token`).

## Modelo legado (React, `portalSync.js`)

- Sem fila persistente: falha espera o próximo tick (boot 4s, 5min, SSE).
- Histórico só marca enviado com **0 falhas**; sem pareamento `enviarPedidosDia` retorna `{ok:0,falhas:0}` **sem log** → flag `_pushHistoricoPedidos` nunca vira true.
- `src/App.jsx:77` sobrescreve `window.kioskPair` mesmo quando `res.ok === false`.
- Auditoria não é persistida no sidecar pelo React → push perdido se o portal cair.

## Comandos úteis

- Saúde do sidecar: `GET http://127.0.0.1:9877/api/health` → `{ok:true, filaPortal}` (health usa `ok`, o resto do sidecar usa `success`).
- Fila/cache: `GET /api/portal/fila`, `GET /api/cache/portal`.
- Saúde do portal: `?action=health`; `?action=login` com a loja/usuário reais.
- Logs do sidecar: console do processo `sidecar/natal-core.cjs` (spawnado por `electron-main.cjs`).
- Dados locais: `%APPDATA%\natal-app\` (`pedidos.json`, `caixa.json`, `caixas.json`, `config.json`, `auditoria.json`, `fila-portal.json`, `cache-portal.json`, `enviados-portal.json`).
- Dados do portal: `backend/data/*.json`; deploy: `backend/publish.ps1`.
- Senha de manutenção da fila: `HCss221087` (env `NATAL_LIMPEZA_SENHA`).
- Reset completo do PDV: `tools/limpar-dados-pdv.ps1 [-DryRun] [-Completo]` (recusa rodar com o app aberto).
