import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => readFileSync(path.join(root, ...partes), 'utf8');

function extrairFuncao(html, nome) {
  let inicio = html.indexOf('function ' + nome + '(');
  if (inicio < 0) throw new Error('funcao nao encontrada: ' + nome);
  if (html.slice(Math.max(0, inicio - 6), inicio) === 'async ') inicio -= 6;
  let i = html.indexOf('(', inicio);
  let parenteses = 0;
  for (; i < html.length; i++) {
    if (html[i] === '(') parenteses++;
    else if (html[i] === ')') {
      parenteses--;
      if (parenteses === 0) {
        i++;
        break;
      }
    }
  }
  while (i < html.length && html[i] !== '{') i++;
  let profundidade = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') profundidade++;
    else if (html[i] === '}') {
      profundidade--;
      if (profundidade === 0) return html.slice(inicio, i + 1);
    }
  }
  throw new Error('fim da funcao nao encontrado: ' + nome);
}

const fmt = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function conciliacao(f) {
  const fonte = extrairFuncao(ler('vendas.html'), 'conciliacaoReceiptTexto');
  return new Function('fmt', fonte + '\nreturn conciliacaoReceiptTexto;')(fmt)(f);
}

const fechamento = {
  numero: 1,
  data: new Date(2026, 10, 10, 22, 21, 42),
  fundoTroco: 200,
  fechadoPor: 'Flavio',
  valorEnvelope: 0,
  saldoRestante: 200,
  diferencaTotal: -385,
  porForma: [
    { forma: 'Cr\u00e9dito', sistema: 252, real: 0, diferenca: -252 },
    { forma: 'Dinheiro', sistema: 83, real: 0, diferenca: -83 },
    { forma: 'D\u00e9bito', sistema: 20, real: 0, diferenca: -20 },
    { forma: 'PIX', sistema: 30, real: 0, diferenca: -30 },
  ],
};

const esperado = [
  '        MAX FOTO VENDAS',
  '      CONCILIACAO DE CAIXA',
  '           Caixa no 1',
  '      <DATA>',
  '--------------------------------',
  'Cr\u00e9dito',
  '  Sistema              R$ 252,00',
  '  Real                   R$ 0,00',
  '  Diferenca           R$ -252,00',
  'Dinheiro',
  '  Sistema               R$ 83,00',
  '  Real                   R$ 0,00',
  '  Diferenca            R$ -83,00',
  'D\u00e9bito',
  '  Sistema               R$ 20,00',
  '  Real                   R$ 0,00',
  '  Diferenca            R$ -20,00',
  'PIX',
  '  Sistema               R$ 30,00',
  '  Real                   R$ 0,00',
  '  Diferenca            R$ -30,00',
  '--------------------------------',
  'DIFERENCA TOTAL       R$ -385,00',
  'Envelope (sangria)       R$ 0,00',
  'Ficou no caixa         R$ 200,00',
  '--------------------------------',
  '       Fechado por Flavio',
  '',
].join('\n');

test('conciliacao impressa permanece no formato da 1.3.19', () => {
  const texto = conciliacao(fechamento);
  const normalizado = texto.replace(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/, '<DATA>');
  assert.equal(normalizado, esperado);
  assert.equal(texto.length, 748);
  assert.equal(texto.split('\n').length, 28);
  assert.equal(Math.max(...texto.split('\n').map((linha) => linha.length)), 32);
  assert.ok(texto.endsWith('\n'));
});

test('conciliacao nao volta a incluir fundo/malote/digitado no cupom', () => {
  const texto = conciliacao(fechamento);
  assert.ok(texto.includes('Envelope (sangria)'));
  assert.ok(!texto.includes('Fundo inicial'));
  assert.ok(!texto.includes('Malote (envelope)'));
  assert.ok(!texto.includes('Digitado'));
});

test('cupom de venda mantem o layout de 32 colunas', () => {
  const html = ler('vendas.html');
  const fonte = extrairFuncao(html, 'wrapCols') + '\n' + extrairFuncao(html, 'cupomBematechTexto');
  const cupom = new Function('fmt', 'urlNatal', fonte + '\nreturn cupomBematechTexto;')(fmt, () => 'https://natal.local/');
  const texto = cupom({
    loja: 'MAXX FOTO',
    pdv: 'PDV 1',
    operador: 'Flavio',
    data: '10/11/2026, 22:21:42',
    pedidoId: 'PED-1',
    senhas: ['A123'],
    itens: [{ label: 'Foto 10x15', qtd: 2, preco: 5 }],
    total: 10,
    pagamentos: 'Dinheiro: R$ 10,00',
    codigoDigital: null,
    via: null,
  });
  const esperadoCupom = [
    '           MAXX FOTO',
    '         PDV 1 - Flavio',
    '      10/11/2026, 22:21:42',
    '--------------------------------',
    'Pedido: PED-1',
    'Sess\u00e3o: A123',
    '--------------------------------',
    '2x Foto 10x15',
    '                         R$ 5,00',
    '--------------------------------',
    'Dinheiro                R$ 10,00',
    '--------------------------------',
    'TOTAL                   R$ 10,00',
    '--------------------------------',
    '   Obrigado pela prefer\u00eancia!',
    '',
  ].join('\n');
  assert.equal(texto, esperadoCupom);
  assert.ok(texto.split('\n').every((linha) => linha.length <= 32));
});

test('cupom digital mantem o bloco FOTO DIGITAL', () => {
  const html = ler('vendas.html');
  const fonte = extrairFuncao(html, 'wrapCols') + '\n' + extrairFuncao(html, 'cupomBematechTexto');
  const cupom = new Function('fmt', 'urlNatal', fonte + '\nreturn cupomBematechTexto;')(
    fmt,
    () => 'https://natal.example.com/',
  );
  const texto = cupom({
    loja: 'MAXX FOTO',
    pdv: 'PDV 1',
    operador: 'Flavio',
    data: '10/11/2026, 22:21:42',
    pedidoId: 'PED-1',
    senhas: ['A123'],
    itens: [{ label: 'Foto 10x15', qtd: 2, preco: 5 }],
    total: 10,
    pagamentos: 'Dinheiro: R$ 10,00',
    codigoDigital: 'ABC123',
    via: null,
  });
  const idx = texto.indexOf('FOTO DIGITAL');
  assert.ok(idx >= 0, 'bloco FOTO DIGITAL nao encontrado');
  const inicioLinha = texto.lastIndexOf('\n', idx) + 1;
  const bloco = texto.slice(inicioLinha);
  const esperadoBloco = [
    '          FOTO DIGITAL',
    'Escaneie o QR abaixo ou acesse:',
    '     www.natal.example.com',
    '     e digite o seu c\u00f3digo',
    '',
  ].join('\n');
  assert.equal(bloco, esperadoBloco);
});

test('imprimirBematechTexto envia o texto pelo IPC do Electron', async () => {
  const fonte = extrairFuncao(ler('vendas.html'), 'imprimirBematechTexto');
  const chamadas = [];
  const windowMock = {
    natal: {
      ipcInvoke: async (canal, payload) => {
        chamadas.push({ canal, payload });
        return { success: true };
      },
    },
  };
  const natalApi = { imprimirThermal: async () => { throw new Error('fallback inesperado'); } };
  const fn = new Function('window', 'natalApi', 'toast', fonte + '\nreturn imprimirBematechTexto;')(
    windowMock,
    natalApi,
    () => {},
  );
  assert.equal(await fn('TEXTO', 'rotulo'), true);
  assert.deepEqual(chamadas, [{ canal: 'natal:printBematech', payload: { texto: 'TEXTO' } }]);
});

test('imprimirBematechTexto usa o sidecar quando nao esta no Electron', async () => {
  const fonte = extrairFuncao(ler('vendas.html'), 'imprimirBematechTexto');
  const chamadas = [];
  const natalApi = {
    imprimirThermal: async (payload) => {
      chamadas.push(payload);
      return { success: true };
    },
  };
  const fn = new Function('window', 'natalApi', 'toast', fonte + '\nreturn imprimirBematechTexto;')(
    {},
    natalApi,
    () => {},
  );
  assert.equal(await fn('TEXTO'), true);
  assert.deepEqual(chamadas, [{ texto: 'TEXTO' }]);
});

test('handler do Electron delega a impressao para o modulo compartilhado', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /ipcMain\.handle\('natal:printBematech'/);
  assert.match(main, /printBematech\(\{ \.\.\.payload, printerName \}\)/);
  assert.match(main, /getThermalPrintPath\(\)/);
  assert.match(main, /IMPRESSORA_TERMICA_NAO_CONFIGURADA/);
});

test('modulo thermal usa a impressora configurada e valida o spooler', () => {
  const thermal = ler('sidecar', 'thermal-print.cjs');
  assert.match(thermal, /const printer = String\(printerName \|\| ''\)\.trim\(\)/);
  assert.match(thermal, /IMPRESSORA_TERMICA_NAO_CONFIGURADA/);
  assert.match(thermal, /PrinterSettings\.IsValid/);
  assert.match(thermal, /Get-PrintJob/);
  assert.match(thermal, /System\.Drawing\.Printing\.PrintDocument/);
});

test('filtro do dia usa a data local do pedido', () => {
  const html = ler('vendas.html');
  const fonte = [
    extrairFuncao(html, 'chaveDia'),
    extrairFuncao(html, 'pedidoDoDia'),
    extrairFuncao(html, 'filtrarPedidosDoDia'),
  ].join('\n');
  const { chaveDia, pedidoDoDia, filtrarPedidosDoDia } = new Function(
    fonte + '\nreturn { chaveDia, pedidoDoDia, filtrarPedidosDoDia };'
  )();
  const hoje = new Date(2026, 10, 11, 10, 0, 0);
  const ontem = new Date(2026, 10, 10, 23, 59, 0);
  const dia = chaveDia(hoje);
  const pedidos = [
    { id: '1', horario: hoje },
    { id: '2', horario: ontem },
    { id: '3', horario: null },
  ];
  assert.equal(pedidoDoDia(pedidos[0], dia), true);
  assert.equal(pedidoDoDia(pedidos[1], dia), false);
  assert.equal(pedidoDoDia(pedidos[2], dia), false);
  assert.deepEqual(filtrarPedidosDoDia(pedidos, dia).map(p => p.id), ['1']);
  assert.deepEqual(filtrarPedidosDoDia(null, dia), []);
});

test('numeroDoPedido exibe o numero sequencial e preserva o id interno', () => {
  const fonte = extrairFuncao(ler('vendas.html'), 'numeroDoPedido');
  const numeroDoPedido = new Function(
    'pedidosRealizados',
    fonte + '\nreturn numeroDoPedido;'
  )([
    { id: 'PED-a', _realId: 'PED-a', numero: 7 },
    { id: '8', _realId: 'PED-b', numero: 8 },
  ]);
  assert.equal(numeroDoPedido('PED-a'), '7');
  assert.equal(numeroDoPedido('PED-b'), '8');
  assert.equal(numeroDoPedido('PED-inexistente'), 'PED-inexistente');
});

test('cupom recebe o numero sequencial e a lista usa o filtro diario', () => {
  const html = ler('vendas.html');
  assert.match(html, /const pedidoNumero = novoPedido\.numero \?\? novoPedido\.id/);
  assert.match(html, /pedidoId: numeroCupom/);
  assert.match(html, /const pedidosHoje = filtrarPedidosDoDia\(pedidosRealizados, pedidosDiaSelecionado\)/);
  assert.match(html, /\[\.\.\.pedidosHoje\]\.reverse\(\)/);
});

test('tela de pedidos permite escolher o dia e mantem hoje como padrao', () => {
  const html = ler('vendas.html');
  assert.match(html, /id="ped-date-select"/);
  assert.match(html, /let pedidosDiaSelecionado = null/);
  assert.match(html, /pedidosDiaSelecionado = hoje/);
  assert.match(html, /selDia\.onchange = \(\)=>\{ pedidosDiaSelecionado = selDia\.value; renderPedidosScreen\(\); \}/);
});

test('modal de reabertura permite reimprimir o cupom do pedido', () => {
  const html = ler('vendas.html');
  assert.match(html, /id="ro-cupom"/);
  assert.match(html, /btnCupom\.addEventListener\('click', \(\)=>\{\s*reimprimirCupomPedido\(p\);/);
});

test('reimpressao pela reabertura reconstroi itens, desconto e pagamentos', () => {
  const html = ler('vendas.html');
  const fonte = extrairFuncao(html, 'reimprimirCupomPedido');
  let capturado = null;
  const fn = new Function(
    'imprimirCupomVenda',
    'fmt',
    fonte + '\nreturn reimprimirCupomPedido;'
  )((args) => { capturado = args; return true; }, fmt);

  const retorno = fn({
    id: '12', _realId: 'PED-X', numero: 12, total: 18,
    itens: [
      { label: 'Foto 10x15', qtd: 1, preco: 23 },
      { label: 'Porta-foto', qtd: 1, preco: 5 },
    ],
    desconto: { nome: 'Desconto do combo "X"', valor: 10, tipo: 'combo' },
    sessoes: [{ senha: 'A123' }, { senha: 'A123' }, { senha: 'B456' }],
    pagamentosEfetivos: [
      { forma: 'Dinheiro', valor: 18 },
      { forma: 'PIX', valor: 0 },
    ],
    codigoDigital: 'ABC123',
  });

  assert.equal(retorno, true);
  assert.equal(capturado.pedidoNumero, 12);
  assert.equal(capturado.pedidoId, 'PED-X');
  assert.equal(capturado.total, 18);
  assert.deepEqual(capturado.senhasResumo, ['A123', 'B456']);
  assert.equal(capturado.pagamentos, 'Dinheiro: R$ 18,00');
  assert.deepEqual(capturado.itensResumo.map((i) => i.preco), [23, 5, -10]);
  assert.equal(capturado.codigoDigital, 'ABC123');

  capturado = null;
  fn({
    id: '13', numero: 13, total: 20,
    itens: [{ label: 'Foto 15x20', qtd: 1, preco: 15 }],
    sessoes: [{ senha: 'C789' }],
    pagamentosEfetivos: [{ forma: 'Crédito', valor: 20 }],
  });
  assert.deepEqual(capturado.itensResumo.map((i) => i.preco), [15, 5]);
  assert.equal(capturado.itensResumo[1].label, 'Ajuste');
});

test('seletor de dias lista os dias com venda e ignora data invalida', () => {
  const html = ler('vendas.html');
  const fonte = [
    extrairFuncao(html, 'chaveDia'),
    extrairFuncao(html, 'diasComVendas'),
  ].join('\n');
  const diasComVendas = new Function(
    'pedidosRealizados',
    fonte + '\nreturn diasComVendas;'
  )([
    { id: '1', horario: new Date(2026, 10, 10, 10, 0, 0) },
    { id: '2', horario: new Date(2026, 10, 11, 10, 0, 0) },
    { id: '3', horario: null },
  ]);
  assert.deepEqual(diasComVendas(), ['11/11/2026', '10/11/2026']);
});

test('modal de impressora desconectada nao pisca durante a saida do papel', () => {
  const html = ler('vendas.html');
  const fonte = extrairFuncao(html, '_impressaoEmAndamento');
  assert.ok(fonte.includes('printando'));
  assert.ok(fonte.includes('_printFinalizadoEm'));
  assert.ok(fonte.includes('PRINTER_ALERT_GRACE_MS'));

  const criar = (printando, finalizadoEm, graca) => new Function(
    'printando',
    '_printFinalizadoEm',
    'PRINTER_ALERT_GRACE_MS',
    fonte + '\nreturn _impressaoEmAndamento;'
  )(printando, finalizadoEm, graca);

  assert.equal(criar(true, 0, 20000)(), true, 'imprimindo');
  assert.equal(criar(false, Date.now() - 1000, 20000)(), true, 'papel saindo');
  assert.equal(criar(false, Date.now() - 60000, 20000)(), false, 'depois da saida');

  const mostrar = extrairFuncao(html, 'mostrarPrinterAlert');
  const render = extrairFuncao(html, 'renderPrinterAlert');
  assert.ok(mostrar.includes('_impressaoEmAndamento()'));
  assert.ok(render.includes('desconectada && _impressaoEmAndamento()'));
  assert.ok(html.includes("if(key==='print-complete'){"));
  assert.ok(html.includes('_printFinalizadoEm = Date.now()'));
});

test('painel digital oferece escolher a foto quando nao ha referencia', () => {
  const html = ler('vendas.html');
  const painel = extrairFuncao(html, 'renderDigitalConfigPanel');
  assert.ok(painel.includes('data-regerar-digital'), 'botao Regerar e enviar');
  assert.ok(painel.includes('data-escolher-digital'), 'botao Escolher foto e enviar');
  assert.ok(painel.includes('data-sync-digital'), 'botao Sincronizar');
  assert.ok(painel.includes('const semRefs = faltamArquivos > 0 && !podeRegerar'));

  const escolher = extrairFuncao(html, 'abrirEscolherFotoDigital');
  assert.ok(escolher.includes('natalApi.fotoUrl'), 'usa o original da sessao escolhida');
  assert.ok(escolher.includes('composePrintImage'), 'compoe a foto escolhida');
  assert.ok(escolher.includes('enviarGaleria'), 'sobe a foto para o codigo');
  assert.ok(escolher.includes('finalizarGaleria'), 'grava as refs no sidecar');
  assert.ok(escolher.includes('sincronizarGaleria'), 'publica o manifesto');
});

if (existsSync(path.join(root, 'dist', 'vendas.html'))) {
  test('bundle gerado contem o texto antigo da conciliacao', () => {
    const html = ler('dist', 'vendas.html');
    const match = html.match(/assets\/(pdv-[^"]+\.js)/);
    assert.ok(match, 'bundle pdv nao encontrado em dist/vendas.html');
    const bundle = ler('dist', 'assets', match[1]);
    assert.ok(bundle.includes('Envelope (sangria)'));
    assert.ok(!bundle.includes('Malote (envelope)'));
    assert.ok(!bundle.includes('Digitado'));
  });
}
