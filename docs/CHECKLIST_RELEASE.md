# Checklist de Release

Versão avaliada: ________  
Data: ________  
Responsável: ________  
Instalador testado: ________  
SHA256 do instalador: ________

Status: `PASS` | `FAIL` | `BLOCKED` | `NA`  
Todo item `NA` precisa de justificativa. Hardware real não pode ser substituído por teste automatizado.

## 1. Artefatos e origem do build

- [ ] `package.json` tem a versão nova e ela é maior que a última publicada.
- [ ] `npm run lint`, `npm test` e `npm run test:importer` passaram no commit exato do release.
- [ ] `npm run build:importador` gerou o executável esperado.
- [ ] `npm run build` foi executado depois da última alteração em `vendas.html`.
- [ ] O instalador foi gerado a partir do worktree atual, não de `release/` ou `release-teste/` antigos.
- [ ] `latest.yml` do release tem o mesmo SHA512/tamanho do instalador gerado.
- [ ] O sidecar empacotado em `resources/natal-core.cjs` corresponde ao fonte do commit.
- [ ] O importador empacotado é o binário gerado neste build.
- [ ] Nenhum artefato `.27`, `.28` ou `.29` foi reutilizado por engano.

## 2. Instalação e atualização

- [ ] Instalação limpa em máquina sem versão anterior.
- [ ] Instalação sobre uma versão anterior preserva `photosFolder`, `machineId` e `kioskCode`.
- [ ] O instalador cria as regras de firewall TCP 8099 e UDP 50000 para o importador.
- [ ] O auto-update detecta a versão nova e só instala após ação do operador.
- [ ] “Agora não” não reinstala a atualização no mesmo boot.
- [ ] Desinstalação remove os arquivos do programa sem apagar a pasta de fotos do cliente.

## 3. Boot, sidecar e portas

- [ ] O Electron abre o PDV sem tela branca e sem erro no console.
- [ ] O sidecar responde em `GET /api/health`.
- [ ] A porta 9877 não fica presa após fechar e reabrir o PDV.
- [ ] O importador sobe em 8099 e `GET /api/import/status` mostra `online: true`.
- [ ] Se o importador cair, o watchdog religa e a aba Cartão mostra o motivo real.
- [ ] O botão “Reiniciar importador” funciona.
- [ ] `main.log` e `importador.log` são gravados e rotacionam.

## 4. Login, perfis e PDV Tablet

- [ ] Login de vendedora, gerente, admin e fotógrafo funciona.
- [ ] Vendedora, gerente e admin veem o botão **PDV Tablet**.
- [ ] Fotógrafo não vê o PDV Tablet, Pedidos, Vendas, caixa nem ribbon.
- [ ] Sem operador logado o PDV Tablet fica oculto.
- [ ] O QR do PDV Tablet abre no tablet pela rede local.
- [ ] O tablet mostra a sessão e as fotos corretas do PC que gerou o QR.
- [ ] A senha master, descontos e cancelamentos continuam exigindo autorização.

## 5. Caixa

- [ ] Primeiro login de operador de venda abre o caixa.
- [ ] Abertura, venda em dinheiro/débito/crédito/PIX e fechamento funcionam.
- [ ] Fechamento com diferença mostra o valor e permite envelope/saldo restante.
- [ ] Histórico de caixas aparece em `GET /api/pdv/caixas`.
- [ ] Reiniciar o PDV não perde o caixa aberto.
- [ ] Fotógrafo não consegue abrir/fechar caixa.

## 6. Sessões e drop zone

- [ ] Uma subpasta em `photosFolder` cria uma sessão `PRONTA`.
- [ ] Arquivos `.part`, `.tmp`, `.crdownload` e menores que 1 KB são ignorados.
- [ ] Uma pasta não gera sessão duplicada após reiniciar o sidecar.
- [ ] Sessão cancelada não é recriada pelo watcher.
- [ ] `criadaEm` e `prontaEm` correspondem à pasta e à importação.
- [ ] A sessão aparece no tablet e no PDV.

## 7. Importador de cartão

- [ ] Cartão real com JPG e RAW é copiado; vídeo respeita `include_videos`.
- [ ] Fotos já importadas são ignoradas e o cartão mostra “já processado”.
- [ ] Um segundo lote do mesmo cartão cria a próxima sequência (`NATAL-S0002`).
- [ ] Falha de cópia não publica lote parcial e mostra `copy_error`.
- [ ] Falha de publicação não grava `.natal_done` e mostra `publish_error`.
- [ ] O cartão pode ser removido após `finished`, `all_imported` ou `ready_existing`.
- [ ] A pasta `.tmp_importando_*` não fica para trás após sucesso ou erro.
- [ ] O teste automatizado de cartão passou.

## 8. Câmera USB/WPD

- [ ] A Canon EOS REBEL T5 é detectada como câmera, não como telefone.
- [ ] Scan mostra a quantidade de fotos novas.
- [ ] Captura manual cria sessão com as fotos e grava `.natal_camera_index.json`.
- [ ] Segunda captura sem fotos novas mostra “câmera sem novidades”.
- [ ] Erro de leitura/captura mostra `camera_error` e não cria lote vazio.
- [ ] Captura automática, quando habilitada, dispara ao conectar a câmera.
- [ ] O teste automatizado com câmera falsa passou.

## 9. Outro PC (peer)

- [ ] O peer é encontrado por UDP na rede local.
- [ ] Lotes novos são baixados e o marcador só aparece após todos os arquivos.
- [ ] Download interrompido não gera `.natal_done` e é retentado.
- [ ] Lote local com mesmo nome e conteúdo diferente é preservado; o remoto baixa com sufixo.
- [ ] Lote com o mesmo conteúdo e outro nome não é duplicado.
- [ ] O botão “Procurar fotos agora” força a sincronização.
- [ ] A topbar mostra “outro PC conectado” e o progresso de download.
- [ ] O teste automatizado de peer passou.

## 10. Recebimento parcial

- [ ] Lote sem `.natal_done` aparece como `RECEBENDO` no sidecar.
- [ ] A sessão parcial mantém o mesmo ID até o marcador final.
- [ ] `fotosEsperadas`, `recebendoDesde` e progresso são exibidos.
- [ ] Pedido/finalização manual retorna 409 enquanto a sessão está `RECEBENDO`.
- [ ] Cancelar lote parcial impede o watcher de recriá-lo.
- [ ] A sessão vira `PRONTA` quando todos os arquivos chegam.

## 11. Editor, vendas e carrinho

- [ ] Abrir uma sessão carrega previews e miniaturas.
- [ ] Editor aplica zoom, deslocamento, rotação e orientação.
- [ ] Overlay da loja, logo do shopping e moldura aparecem corretamente.
- [ ] Adicionar tamanhos, extras, combos e encarte recalcula o carrinho.
- [ ] Remover item/alterar quantidade remove o desconto do combo correspondente.
- [ ] Catálogo do portal é aplicado; offline usa o último cache.
- [ ] Preço, desconto e total batem com o catálogo vigente.

## 12. Pagamentos, descontos e auditoria

- [ ] Pagamento simples e múltiplos meios funcionam.
- [ ] Linha de ajuste/diferença aceita valor negativo e total fecha.
- [ ] Desconto, perda e cancelamento exigem senha master.
- [ ] Cada uso de senha master gera registro em `auditoria.json`.
- [ ] O uso de auditoria é enfileirado para o portal.
- [ ] Pedido pago aparece em Pedidos e no resumo do dia.
- [ ] Pedido cancelado não entra no total líquido.

## 13. Impressão

- [ ] Status da ASK-400 mostra papel 10x15/15x20 e conexão.
- [ ] Impressão 10x15 e 15x20 sai na mídia correta.
- [ ] Fila de impressão sobrevive a reinício e não duplica.
- [ ] Teste de impressão do fotógrafo respeita o limite de 2/dia.
- [ ] Teste de impressão não vira pedido/venda nem altera a sessão.
- [ ] Comanda térmica imprime código da venda e dados corretos.
- [ ] Erro de impressora aparece no alerta e pode ser dispensado.

## 14. Portal, fila e sincronização

- [ ] Login online e login offline (TOFU) funcionam.
- [ ] `kiosk.seed` cria rascunho e `kiosk.pair`/autorização pareia a máquina.
- [ ] Snapshot de vendas sobe e aparece no admin.
- [ ] Pedidos e auditoria sobem de forma idempotente.
- [ ] Sem internet, os itens entram na fila e são drenados quando a rede volta.
- [ ] “Limpar fila de envio” exige a senha correta.
- [ ] Envio digital sobe fotos e manifesto; `/natal` só lista após o manifesto.
- [ ] QR/código do envio digital abre a galeria correta.

## 15. Tablet e rede local

- [ ] O tablet abre o PDV pelo IP do PC na porta 9877.
- [ ] Sessões, fotos, editor e carrinho funcionam no toque.
- [ ] O tablet não mostra dados de outra loja/máquina.
- [ ] A tela continua utilizável com Wi-Fi lento.
- [ ] O QR do PDV Tablet aponta para o host/porta corretos.
- [ ] O tablet não acessa o PDV Tablet se o operador for fotógrafo.

## 16. Resiliência, segurança e encerramento

- [ ] Matar o importador não derruba o PDV; o watchdog religa.
- [ ] Matar o sidecar não deixa a porta 9877 presa.
- [ ] Reiniciar o Windows mantém identidade, pasta de fotos e caixa.
- [ ] Não há senhas, tokens ou chaves novas no repositório/log.
- [ ] `window.prompt` não é usado em fluxo novo do Electron.
- [ ] Backup de `database`, `sessoes` e `pasta-importadas.json` foi feito antes do teste destrutivo.
- [ ] Logs e evidências (prints, hashes, JSONs) foram anexados ao registro do release.

## Evidências obrigatórias

- [ ] Saída de `npm run lint`.
- [ ] Saída de `npm test`.
- [ ] Saída de `npm run test:importer` em Windows.
- [ ] Hash SHA256 do instalador e do `latest.yml`.
- [ ] Print da aba Cartão com importador online.
- [ ] Print de uma sessão importada do cartão.
- [ ] Print de uma sessão importada da câmera.
- [ ] Print do peer conectado e de um lote recebido.
- [ ] Print de uma venda paga e da comanda impressa.
- [ ] Print do caixa fechado com conciliação.

## Critério de aceite

O release só pode ser publicado se:

1. todos os itens de software estiverem `PASS`;
2. itens de hardware/rede sem equipamento estiverem `NA` com justificativa e responsável;
3. nenhum item estiver `FAIL` ou `BLOCKED`;
4. os hashes do instalador e do `latest.yml` forem os do build validado;
5. a auditoria `docs/AUDITORIA_1327_VS_1328.md` estiver reconciliada com a versão publicada.
