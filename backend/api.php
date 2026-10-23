<?php
/**
 * Maxx Natal Controller — API de cadastro (lojas, vendedores, fotógrafos).
 * Backend single-file para hospedagem compartilhada (PHP 7.4+/8.x).
 * Dados em JSON sob /data (bloqueado na web via .htaccess).
 *
 * Ações públicas : health, login, equipe, kiosk.seed, kiosk.pair, precos,
 *                  vendas.push, pedido.push, auditoria.push
 * Ações admin    : exigem X-Token (header) ou campo "token":
 *   admin.login, lojas.list, lojas.save, lojas.delete,
 *   usuarios.list, usuarios.save, usuarios.delete, admin.changePassword,
 *   precos.save, vendas.resumo, pedido.list, auditoria.list,
 *   despesas.list, despesas.save, despesas.delete,
 *   parametros.get, parametros.save
 *
 * Wizard de 1º uso (kiosk.seed + lojas.save com código-only):
 *   1) o PDV registra o NOME DO LOCAL em `pendentes[kioskCode]` (rascunho,
 *      não cria loja);
 *   2) o admin abre "Nova loja" no portal, cola SÓ o código que aparece na
 *      tela do PDV e salva — lojas.save resolve nome/pdv/máquina do rascunho,
 *      gera o id (slug do nome) e grava o pareamento na hora;
 *   3) em seguida o admin cadastra os colaboradores da nova loja.
 *
 * Emparelhamento (kiosk.pair): cada loja tem um pairingCode gerado no admin.
 * O PDV envia { lojaId, pairingCode, pdvNome, machineId } e o portal valida
 * o código e impede dois kiosks de usarem o mesmo código/máquina (evita que
 * imagens clonadas misturem dados).
 *
 * Métodos: GET (action na query) ou POST (action na query ou no corpo JSON).
 */

declare(strict_types=1);

mb_internal_encoding('UTF-8');

define('APP_VERSION', '1.0.0');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/config.php';

// ─── Helpers ─────────────────────────────────────────────────────────

function respond(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $error, int $code = 400): void
{
    respond(['ok' => false, 'error' => $error], $code);
}

function input(): array
{
    $raw = file_get_contents('php://input');
    $json = json_decode($raw ?: '', true);
    return is_array($json) ? $json : [];
}

function sha256(string $s): string
{
    return hash('sha256', $s);
}

function dataFile(string $name): string
{
    return APP_DATA_DIR . '/' . $name;
}

function loadJson(string $name, $default = null)
{
    $path = dataFile($name);
    if (!is_file($path)) return $default;
    $txt = @file_get_contents($path);
    $data = json_decode((string) $txt, true);
    if (is_array($data)) return $data;
    // JSON ilegível: preserva a evidência antes de devolver o default — corrupção
    // nunca mais apaga dado em silêncio (vale para qualquer arquivo de dados).
    if (strlen(trim((string) $txt)) > 0) {
        $stamp = date('Ymd-His');
        @copy($path, dataFile($name . '.corrupted-' . $stamp));
        error_log('[natalcontroler] ' . $name . ' ilegível; preservado em ' . $name . '.corrupted-' . $stamp);
    }
    return $default;
}

function saveJson(string $name, array $data): bool
{
    // Escrita atômica: grava num .tmp e renomeia por cima. Nunca deixa o JSON pela
    // metade (se o processo morrer/quota estourar no meio, o arquivo antigo continua
    // válido) — pasta data estava sujeita a corrupção e a API reescrevia o padrão.
    $path = dataFile($name);
    $fp = @fopen($path . '.lock', 'c');
    if ($fp) flock($fp, LOCK_EX);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $tmp = $path . '.' . getmypid() . '.tmp';
    $ok = @file_put_contents($tmp, $json, LOCK_EX) !== false;
    if ($ok) $ok = @rename($tmp, $path); // mesmo diretório ⇒ atômico (substitui o existente)
    if (!$ok && is_file($tmp)) @unlink($tmp);
    if ($fp) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
    return $ok;
}

function FUNCOES(): array
{
    return ['vendedor', 'fotografo', 'admin', 'gerente'];
}

function seed(): array
{
    return [
        'lojas' => [
            ['id' => 'teste', 'nome' => 'Kiosk Teste', 'pdv' => 'VENDA-01', 'pairingCode' => 'TESTE26', 'ativo' => true],
        ],
        'usuarios' => [
            ['id' => 'u-admin', 'lojaId' => 'teste', 'usuario' => 'admin', 'nome' => 'ADMINISTRADOR', 'funcao' => 'admin', 'senha' => '1234', 'ativo' => true],
            ['id' => 'u-vendedor', 'lojaId' => 'teste', 'usuario' => 'vendedor', 'nome' => 'VENDEDOR', 'funcao' => 'vendedor', 'senha' => '1234', 'ativo' => true],
            ['id' => 'u-foto', 'lojaId' => 'teste', 'usuario' => 'fotografo', 'nome' => 'FOTOGRAFO 1', 'funcao' => 'fotografo', 'senha' => '1234', 'ativo' => true],
        ],
    ];
}

/* ---------------- Backups automáticos (em data/backups/, no próprio servidor) ---------------- */
function bkpBase(): string
{
    return APP_DATA_DIR . '/backups';
}
function ensureBkpDir(string $sub): bool
{
    $dir = bkpBase() . '/' . $sub;
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return is_dir($dir);
}
// Snapshot diário completo de todos os JSONs (máx. 1x/dia). Serve para recuperação
// manual e como fonte da auto-restauração do app.json. Mantém os últimos 14 dias.
function backupDiario(): void
{
    $today = date('Y-m-d');
    $sub = 'daily/' . $today;
    if (is_dir(bkpBase() . '/' . $sub)) return; // já rodou hoje
    if (!ensureBkpDir($sub)) return;
    foreach (glob(APP_DATA_DIR . '/*.json') ?: [] as $f) {
        @copy($f, bkpBase() . '/' . $sub . '/' . basename($f));
    }
    $days = @glob(bkpBase() . '/daily/*', GLOB_ONLYDIR) ?: [];
    rsort($days); // nome Y-m-d ⇒ do mais novo para o mais antigo
    foreach (array_slice($days, 14) as $old) {
        foreach (glob($old . '/*') ?: [] as $of) @unlink($of);
        @rmdir($old);
    }
    error_log('[natalcontroler] backup diário completo: ' . $sub);
}
// Snapshot do app.json ANTES de cada alteração de lojas/usuários (histórico fino de config).
function snapshotConfig(): void
{
    if (!ensureBkpDir('history')) return;
    $src = dataFile('app.json');
    if (!is_file($src) || filesize($src) < 1) return;
    $stamp = date('Ymd-His');
    @copy($src, bkpBase() . '/history/app-' . $stamp . '.json');
    $hist = @glob(bkpBase() . '/history/app-*.json') ?: [];
    rsort($hist);
    foreach (array_slice($hist, 80) as $old) @unlink($old);
}
// Restaura o app.json do backup mais recente válido (histórico fino → snapshot diário).
function restoreConfig(): bool
{
    $cands = array_merge(
        @glob(bkpBase() . '/history/app-*.json') ?: [],
        @glob(bkpBase() . '/daily/*/app.json') ?: []
    );
    rsort($cands); // mais recente primeiro (Ymd-His / Y-m-d ordenam desc)
    foreach ($cands as $f) {
        $txt = @file_get_contents($f);
        $d = json_decode((string) $txt, true);
        if (!is_array($d) || !isset($d['lojas']) || $d['lojas'] === []) continue;
        if (saveJson('app.json', $d)) {
            error_log('[natalcontroler] app.json RESTAURADO de ' . basename($f));
            return true;
        }
    }
    return false;
}

function db(): array
{
    $data = loadJson('app.json', null);
    if ($data) {
        backupDiario(); // garante 1 snapshot completo por dia (no-op se já rodou hoje)
        return $data;
    }
    // app.json ilegível/ausente: primeiro TENTA auto-restaurar de um backup.
    if (restoreConfig()) {
        $data = loadJson('app.json', null);
        if ($data) { error_log('[natalcontroler] config recuperada automaticamente de backup'); return $data; }
    }
    // Sem backup utilizável: recria o padrão (o arquivo quebrado já foi preservado pelo loadJson).
    $data = seed();
    saveJson('app.json', $data);
    return $data;
}

function saveDb(array $data): bool
{
    snapshotConfig(); // guarda o estado atual antes de qualquer alteração
    $ok = saveJson('app.json', $data);
    backupDiario();
    return $ok;
}

function uid(): string
{
    return 'u-' . substr(bin2hex(random_bytes(8)), 0, 10);
}

function adminHash(): string
{
    $adm = loadJson('admin.json', null);
    if ($adm && isset($adm['hash']) && is_string($adm['hash']) && strlen($adm['hash']) === 64) {
        return $adm['hash'];
    }
    return ADMIN_SENHA_SHA;
}

function createToken(): string
{
    $token = bin2hex(random_bytes(24));
    $tokens = loadJson('tokens.json', []);
    foreach ($tokens as $t => $exp) {
        if ($exp < time()) unset($tokens[$t]);
    }
    $tokens[$token] = time() + 12 * 3600;
    saveJson('tokens.json', $tokens);
    return $token;
}

function checkToken(?string $token): bool
{
    if (!$token || strlen($token) < 32) return false;
    $tokens = loadJson('tokens.json', []);
    $exp = $tokens[$token] ?? 0;
    if ($exp && $exp < time()) {
        unset($tokens[$token]);
        saveJson('tokens.json', $tokens);
        return false;
    }
    return $exp > 0;
}

function findLoja(array $data, string $id): ?array
{
    foreach ($data['lojas'] as $l) {
        if (($l['id'] ?? '') === $id) return $l;
    }
    return null;
}

// Slug do nome da loja → id estável e legível (Royal Plaza → royal-plaza).
// Usado pelo wizard de 1º uso (lojas.save com só o código).
function slugLoja(string $nome): string
{
    $s = mb_strtolower($nome, 'UTF-8');
    $s = (function_exists('iconv') ? @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) : false) ?: $s;
    $s = preg_replace('/[^a-z0-9]+/', '-', (string) $s);
    $s = trim((string) $s, '-');
    if ($s === '') $s = 'loja';
    return substr($s, 0, 48);
}

// Valida que o kiosk que está chamando é a máquina pareada com a loja
// (pedido.push / auditoria.push / vendas.push). Protege contra push de dados
// de fora: só a máquina física daquela loja consegue mandar.
// Offline-first: a loja é definida NO APP e o portal só AUTORIZA a máquina,
// então a autorização é resolvida pelo machineId — se ele casa com alguma
// loja pareada, essa é a loja canônica do envio (o lojaId do kiosk pode até
// divergir, ex.: loja recriada no portal).
function validarLojaPareada(array $p): array
{
    $lojaId = trim((string) ($p['lojaId'] ?? ''));
    $machineId = trim((string) ($p['machineId'] ?? ''));
    if ($lojaId === '' || $machineId === '') {
        fail('DADOS_INCOMPLETOS: lojaId e machineId são obrigatórios');
    }
    $db = db();
    $loja = null;
    foreach ((array) ($db['lojas'] ?? []) as $l) {
        if (!is_array($l)) continue;
        if ((string) ($l['pareamento']['machineId'] ?? '') === $machineId) { $loja = $l; break; }
    }
    if (!$loja) {
        // compat: mesma mensagem de sempre quando a máquina não está autorizada
        $antiga = findLoja($db, $lojaId);
        if (!$antiga || empty($antiga['ativo'])) fail('LOJA_INVALIDA', 404);
        usleep(200000);
        fail('LOJA_NAO_EMPARELELHADA', 403);
    }
    if (empty($loja['ativo'])) fail('LOJA_INVALIDA', 404);
    return [$db, $loja];
}

// Nome da loja gravado nos registros do portal: o PDV manda o nome definido
// NO APP (offline-first, exibido no topo do PDV); se vier vazio, usa o
// cadastrado no portal de gestão.
function lojaNomePush(array $p, array $loja): string
{
    $enviado = trim((string) ($p['lojaNome'] ?? ''));
    if ($enviado !== '') return $enviado;
    return (string) ($loja['nome'] ?? ($loja['id'] ?? ''));
}

// "Heartbeat" do kiosk: o PDV manda snapshot (vendas.push) a cada 5 min e
// pedidos/auditoria na hora; o enviadoEm desses é a prova de que a máquina
// está viva. Uma loja é ONLINE se a última conexão for mais recente que 10 min.
const ONLINE_JANELA_SEG = 600;
function conexaoPorLoja(): array
{
    $ult = [];
    foreach (['vendas.json', 'pedidos.json', 'auditoria.json'] as $f) {
        $rows = loadJson($f, []);
        if (!is_array($rows)) continue;
        foreach ($rows as $r) {
            $lid = (string) ($r['lojaId'] ?? '');
            if ($lid === '') continue;
            $env = (string) ($r['enviadoEm'] ?? '');
            if ($env === '') continue;
            if (!isset($ult[$lid]) || $env > $ult[$lid]) $ult[$lid] = $env;
        }
    }
    $agora = time();
    $out = [];
    foreach ($ult as $lid => $env) {
        $ts = strtotime($env);
        $out[$lid] = [
            'ultimaConexao' => $env,
            'conexaoDelta' => ($ts !== false && $ts > 0) ? max(0, (int) ($agora - $ts)) : null,
            'online' => ($ts !== false && $ts > 0) && ($agora - $ts) <= ONLINE_JANELA_SEG,
        ];
    }
    return $out;
}

function userVisible(array $u, bool $withSenha = false): array
{
    $lojas = is_array($u['lojas'] ?? null) ? array_values(array_unique(array_map('strval', $u['lojas']))) : [];
    if (!$lojas && isset($u['lojaId']) && $u['lojaId'] !== '') {
        $lojas = [(string) $u['lojaId']];
    }
    $out = [
        'id' => $u['id'] ?? '',
        'lojaId' => $lojas[0] ?? ($u['lojaId'] ?? ''),
        'lojas' => $lojas,
        'usuario' => $u['usuario'] ?? '',
        'nome' => $u['nome'] ?? '',
        'funcao' => $u['funcao'] ?? 'vendedor',
        'ativo' => !empty($u['ativo']),
    ];
    if ($withSenha) $out['senha'] = $u['senha'] ?? '';
    return $out;
}

// Preços do catálogo — o portal é a fonte de verdade para o PDV. Estes
// defaults são os valores oficiais do evento (catálogo TAMANHOS/combos do PDV
// vendas.html); cada loja pode sobrescrever via admin (precos.save) e o PDV
// busca os efetivos na ação pública 'precos' (chaves: formatos, extras, combos).
const PRECOS_DEFAULT = [
    '10x15' => 15.0, '15x20' => 25.0, 'bolinha' => 12.0, 'polaroide' => 20.0,
    'porta-retrato-10x15' => 35.0, 'porta-retrato-15x20' => 50.0, 'ima' => 10.0,
    'item-encarte' => 15.0, 'porta-cartao-postal' => 12.0,
    'foto-digital' => 10.0,
    'combo1' => 45.0, 'combo2' => 65.0, 'combo3' => 80.0,
    'combo4' => 52.0, 'combo5' => 38.0, 'combo6' => 38.0,
];

// Preços efetivos da loja: defaults oficiais + overlay salvo no portal.
function precosEfetivos(string $lojaId): array
{
    $overlay = [];
    $saved = loadJson('precos.json', []);
    if (is_array($saved) && isset($saved[$lojaId]) && is_array($saved[$lojaId])) {
        $overlay = $saved[$lojaId];
    }
    $out = PRECOS_DEFAULT;
    foreach ($overlay as $k => $v) {
        if (array_key_exists($k, $out) && is_numeric($v) && (float) $v >= 0) {
            $out[$k] = round((float) $v, 2);
        }
    }
    return $out;
}

// ─── Catálogo estruturado (produtos que o PDV mostra) ────────────────────────
// O `precos` é só preço por chave; o catálogo é a LISTA de produtos (tamanhos,
// extras e combos) que a loja pode editar/criar/excluir no admin. O PDV aplica
// esta estrutura a cada 60s — criar/excluir aqui muda o PDV aberto.
//
// `modelo` de um tamanho é o formato físico de impressão (10x15/15x20/bolinha/
// polaroide): um tamanho novo pode ter outro nome/preço, mas sempre imprime num
// desses modelos. `oculto` marca extras de uso interno (Item Encarte, Porta-
// cartão postal) que só aparecem dentro de combos.
const CATALOGO_DEFAULT = [
    'tamanhos' => [
        ['id' => '10x15', 'label' => '10x15', 'preco' => 15.0, 'modelo' => '10x15', 'unidades' => 1],
        ['id' => '15x20', 'label' => '15x20', 'preco' => 25.0, 'modelo' => '15x20', 'unidades' => 2],
        ['id' => 'bolinha', 'label' => 'Bolinha 7,5x7,5', 'preco' => 12.0, 'modelo' => 'bolinha', 'unidades' => 1,
            'nota' => '2 bolinhas iguais por folha 10x15, lado a lado'],
        ['id' => 'polaroide', 'label' => 'Polaroide 2 poses', 'preco' => 20.0, 'modelo' => 'polaroide', 'unidades' => 1,
            'nota' => '2 poses iguais por folha 10x15, lado a lado'],
    ],
    'extras' => [
        ['id' => 'porta-retrato-10x15', 'label' => 'Porta-retrato 10x15', 'preco' => 35.0],
        ['id' => 'porta-retrato-15x20', 'label' => 'Porta-retrato 15x20', 'preco' => 50.0],
        ['id' => 'ima', 'label' => 'Ímã de geladeira', 'preco' => 10.0, 'nota' => 'adicional a uma foto 10x15'],
        ['id' => 'foto-digital', 'label' => '📲 Envio digital (foto)', 'preco' => 10.0, 'digital' => true,
            'nota' => 'a foto escolhida vai para o celular por código'],
        ['id' => 'item-encarte', 'label' => 'Item Encarte', 'preco' => 15.0, 'oculto' => true],
        ['id' => 'porta-cartao-postal', 'label' => 'Porta-cartão postal', 'preco' => 12.0, 'oculto' => true],
    ],
    'combos' => [
        ['id' => 'combo1', 'nome' => 'Foto + Porta-retrato 10x15', 'valorCombo' => 45.0, 'inline' => true,
            'itens' => [['produtoId' => '10x15', 'qtd' => 1], ['produtoId' => 'porta-retrato-10x15', 'qtd' => 1]]],
        ['id' => 'combo2', 'nome' => 'Foto + Porta-retrato 15x20', 'valorCombo' => 65.0, 'inline' => true,
            'itens' => [['produtoId' => '15x20', 'qtd' => 1], ['produtoId' => 'porta-retrato-15x20', 'qtd' => 1]]],
        ['id' => 'combo3', 'nome' => 'Encarte (2 fotos 15x20)', 'valorCombo' => 80.0, 'encarte' => true,
            'itens' => [['produtoId' => '15x20', 'qtd' => 2], ['produtoId' => 'item-encarte', 'qtd' => 1]]],
        ['id' => 'combo4', 'nome' => 'Foto 10x15 + Porta-retrato + Bolinha', 'valorCombo' => 52.0,
            'itens' => [['produtoId' => '10x15', 'qtd' => 1], ['produtoId' => 'porta-retrato-10x15', 'qtd' => 1], ['produtoId' => 'bolinha', 'qtd' => 1]]],
        ['id' => 'combo5', 'nome' => 'Cartão de Natal — Layout 1', 'valorCombo' => 38.0,
            'itens' => [['produtoId' => '10x15', 'qtd' => 1], ['produtoId' => 'porta-cartao-postal', 'qtd' => 1]]],
        ['id' => 'combo6', 'nome' => 'Cartão de Natal — Layout 2', 'valorCombo' => 38.0,
            'itens' => [['produtoId' => '10x15', 'qtd' => 1], ['produtoId' => 'porta-cartao-postal', 'qtd' => 1]]],
    ],
];

function catId($v): string
{
    $s = strtolower(trim((string) $v));
    $s = preg_replace('/[^a-z0-9-]+/', '-', $s);
    $s = trim((string) $s, '-');
    return substr($s, 0, 40);
}

function catTexto($v, int $max = 80): string
{
    return mb_substr(trim(strip_tags((string) $v)), 0, $max);
}

function catPreco($v): float
{
    return (is_numeric($v) && (float) $v >= 0) ? round((float) $v, 2) : 0.0;
}

// Valida/normaliza o catálogo vindo do admin. Devolve null quando inválido
// (sem 10x15/15x20, que são a base da impressão e dos combos).
function sanitizarCatalogo($cat): ?array
{
    if (!is_array($cat)) return null;
    $modelos = ['10x15', '15x20', 'bolinha', 'polaroide'];
    $tipos = [];
    $tamanhos = [];
    foreach ((array) ($cat['tamanhos'] ?? []) as $it) {
        if (!is_array($it)) continue;
        $id = catId($it['id'] ?? '');
        if ($id === '' || isset($tipos[$id])) continue;
        $modelo = in_array(($it['modelo'] ?? ''), $modelos, true) ? $it['modelo'] : $id;
        if (!in_array($modelo, $modelos, true)) $modelo = '10x15';
        // Consumo de ribbon é determinado pelo papel do modelo (15x20 = 2
        // unidades de 10x15); não é editável pela loja.
        $u = ($modelo === '15x20') ? 2 : 1;
        $row = [
            'id' => $id,
            'label' => catTexto($it['label'] ?? $id) ?: $id,
            'preco' => catPreco($it['preco'] ?? 0),
            'modelo' => $modelo,
            'unidades' => $u,
        ];
        $nota = catTexto($it['nota'] ?? '', 160);
        if ($nota !== '') $row['nota'] = $nota;
        $tamanhos[] = $row;
        $tipos[$id] = 'tamanho';
    }
    if (!isset($tipos['10x15']) || !isset($tipos['15x20'])) return null;

    $extras = [];
    foreach ((array) ($cat['extras'] ?? []) as $it) {
        if (!is_array($it)) continue;
        $id = catId($it['id'] ?? '');
        if ($id === '' || isset($tipos[$id])) continue;
        $row = [
            'id' => $id,
            'label' => catTexto($it['label'] ?? $id) ?: $id,
            'preco' => catPreco($it['preco'] ?? 0),
        ];
        if (!empty($it['oculto'])) $row['oculto'] = true;
        if (!empty($it['digital'])) $row['digital'] = true;
        $nota = catTexto($it['nota'] ?? '', 160);
        if ($nota !== '') $row['nota'] = $nota;
        $extras[] = $row;
        $tipos[$id] = 'extra';
    }

    $combos = [];
    foreach ((array) ($cat['combos'] ?? []) as $it) {
        if (!is_array($it)) continue;
        $id = catId($it['id'] ?? '');
        if ($id === '' || isset($tipos[$id])) continue;
        $itens = [];
        foreach ((array) ($it['itens'] ?? []) as $ci) {
            if (!is_array($ci)) continue;
            $pid = catId($ci['produtoId'] ?? '');
            if ($pid === '' || !isset($tipos[$pid])) continue;
            $qtd = (int) ($ci['qtd'] ?? 1);
            if ($qtd < 1) $qtd = 1;
            if ($qtd > 99) $qtd = 99;
            $itens[] = ['produtoId' => $pid, 'tipoProduto' => $tipos[$pid], 'qtd' => $qtd];
        }
        if (!$itens) continue;
        $row = [
            'id' => $id,
            'nome' => catTexto($it['nome'] ?? $id) ?: $id,
            'valorCombo' => catPreco($it['valorCombo'] ?? 0),
            'itens' => $itens,
        ];
        if (!empty($it['inline'])) $row['inline'] = true;
        if (!empty($it['encarte'])) $row['encarte'] = true;
        $alvo = catId($it['tamanhoAlvo'] ?? '');
        if ($alvo !== '') $row['tamanhoAlvo'] = $alvo;
        $combos[] = $row;
        $tipos[$id] = 'combo';
    }

    return ['tamanhos' => $tamanhos, 'extras' => $extras, 'combos' => $combos];
}

// Catálogo efetivo da loja: o salvo (quando existe) ou os defaults com o
// overlay de preços antigo aplicado — garante que a tela do admin e o PDV
// mostrem sempre a mesma lista.
function catalogoEfetivo(string $lojaId): array
{
    $saved = loadJson('precos.json', []);
    $overlay = (is_array($saved) && isset($saved[$lojaId]) && is_array($saved[$lojaId])) ? $saved[$lojaId] : [];
    if (isset($overlay['__catalogo'])) {
        $cat = sanitizarCatalogo($overlay['__catalogo']);
        if ($cat !== null) return $cat;
    }
    $cat = CATALOGO_DEFAULT;
    foreach ($cat['tamanhos'] as $i => $it) {
        if (isset($overlay[$it['id']]) && is_numeric($overlay[$it['id']]) && (float) $overlay[$it['id']] >= 0) {
            $cat['tamanhos'][$i]['preco'] = round((float) $overlay[$it['id']], 2);
        }
    }
    foreach ($cat['extras'] as $i => $it) {
        if (isset($overlay[$it['id']]) && is_numeric($overlay[$it['id']]) && (float) $overlay[$it['id']] >= 0) {
            $cat['extras'][$i]['preco'] = round((float) $overlay[$it['id']], 2);
        }
    }
    foreach ($cat['combos'] as $i => $it) {
        if (isset($overlay[$it['id']]) && is_numeric($overlay[$it['id']]) && (float) $overlay[$it['id']] >= 0) {
            $cat['combos'][$i]['valorCombo'] = round((float) $overlay[$it['id']], 2);
        }
    }
    return $cat;
}

// Nome do PDV que aparece no portal: usa o valor enviado pelo PDV; se vier
// vazio (o PDV sempre envia a chave, mesmo sem configurar pdvNome), cai no
// nome 'pdv' da loja cadastrada no portal em vez de gravar string vazia.
function resolverPdvNome($pdv, array $loja): string
{
    $v = trim((string) ($pdv ?? ''));
    if ($v === '') $v = trim((string) ($loja['pdv'] ?? ''));
    return $v;
}

const MEIOS_CONHECIDOS = ['dinheiro', 'debito', 'credito', 'pix'];

// Normaliza a forma de pagamento de um pagamento do PDV. O lado do PDV já
// manda `meio` canônico ('dinheiro'|'debito'|'credito'|'pix'), mas versões
// antigas gravavam pagamento SEM meio (string vazia) — nesses casos a forma
// ('Dinheiro', 'Crédito 3x', ...) é a única fonte para recuperar o meio, senão
// a venda cai no grupo "Não informado" do Financeiro.
function normalizarMeioPagamento($meio, $forma, &$parcelas = null): string
{
    $m = strtolower(trim((string) ($meio ?? '')));
    if (in_array($m, MEIOS_CONHECIDOS, true)) return $m;
    $f = trim((string) ($forma ?? ''));
    $pl = null;
    if (preg_match('/^Cr[eé]dito\s+(\d+)x$/iu', $f, $mm)) $pl = (int) $mm[1];
    $fSemAcento = strtolower(preg_replace('/\s+/u', ' ', strtr($f, ['á'=>'a','à'=>'a','ã'=>'a','â'=>'a','é'=>'e','ê'=>'e','í'=>'i','ó'=>'o','õ'=>'o','ô'=>'o','ú'=>'u','ç'=>'c'])));
    $mapa = ['dinheiro' => 'dinheiro', 'debito' => 'debito', 'cartao de debito' => 'debito',
             'credito' => 'credito', 'credito a vista' => 'credito', 'cartao de credito' => 'credito',
             'pix' => 'pix'];
    if (isset($mapa[$fSemAcento])) {
        if ($mapa[$fSemAcento] === 'credito') {
            if (preg_match('/(\d+)\s*x$/', $fSemAcento, $mm)) $parcelas = (int) $mm[1];
        }
        return $mapa[$fSemAcento];
    }
    // "Crédito 3x", "Crédito parcelado", ... — qualquer rótulo que comece por
    // crédito é crédito (o número de parcelas vem do sufixo "Nx").
    if (strpos($fSemAcento, 'credito') === 0) {
        if (preg_match('/(\d+)\s*x$/', $fSemAcento, $mm)) $parcelas = (int) $mm[1];
        return 'credito';
    }
    // forma vazia/"—" (pedido gravado sem meio): mantém o que veio, sem inventar.
    return $m;
}

// Soma os meios já classificados de um conjunto de pagamentos.
function somaMeios(array $pagamentos): array
{
    $meios = array_fill_keys(MEIOS_CONHECIDOS, 0.0);
    foreach ($pagamentos as $pg) {
        if (!is_array($pg)) continue;
        $valor = (float) ($pg['valor'] ?? 0);
        if ($valor <= 0) continue;
        $mk = strtolower(trim((string) ($pg['meio'] ?? '')));
        if (isset($meios[$mk])) $meios[$mk] = round($meios[$mk] + $valor, 2);
    }
    return $meios;
}

// Parâmetros globais da operação (Portal define, DRE/Estoque consomem).
// custoRibbonUnitario = custo real por unidade de ribbon (impressa) — usado
// no DRE em vez do 18% fixo do protótipo; comissaoVendedor/Fotografo = % sobre
// as vendas do operador (custo de equipe); ribbonCritico = limite p/ alerta.
const PARAMS_DEFAULT = [
    'custoRibbonUnitario' => 0.0,
    'comissaoVendedor' => 0.0,
    'comissaoFotografo' => 0.0,
    'ribbonCritico' => 100.0,
    // Taxas das maquininhas/PSP aplicadas sobre o faturamento por forma de
    // pagamento no Financeiro (dinheiro não tem taxa).
    'taxaCredito' => 0.0,
    'taxaDebito' => 0.0,
    'taxaPix' => 0.0,
];

function parametrosEfetivos(): array
{
    $out = PARAMS_DEFAULT;
    $saved = loadJson('parametros.json', null);
    if (is_array($saved) && $saved) {
        foreach (PARAMS_DEFAULT as $k => $v) {
            $val = $saved[$k] ?? null;
            if (is_numeric($val) && (float) $val >= 0) $out[$k] = (float) $val;
        }
    }
    $out['custoRibbonUnitario'] = round($out['custoRibbonUnitario'], 2);
    $out['ribbonCritico'] = round($out['ribbonCritico'], 0);
    foreach (['taxaCredito', 'taxaDebito', 'taxaPix'] as $k) {
        $out[$k] = round($out[$k], 2);
    }
    return $out;
}

// ─── Rotas ───────────────────────────────────────────────────────────

$input = input();
$action = $_REQUEST['action'] ?? ($input['action'] ?? '');
$p = array_merge($input, $_REQUEST);
$token = $_SERVER['HTTP_X_TOKEN'] ?? ($p['token'] ?? null);

try {
    switch ($action) {
        // ── Públicas ────────────────────────────────────────
        case 'health':
            respond([
                'ok' => true,
                'app' => 'maxx-natal-controller',
                'version' => APP_VERSION,
                'php' => PHP_VERSION,
                'time' => gmdate('c'),
            ]);

        case 'login': {
            $db = db();
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $usuario = trim((string) ($p['usuario'] ?? ''));
            $senha = (string) ($p['senha'] ?? '');

            $loja = findLoja($db, $lojaId);
            if (!$loja || empty($loja['ativo'])) fail('LOJA_INVALIDA', 401);

            $match = null;
            $lower = mb_strtolower($usuario, 'UTF-8');
            foreach ($db['usuarios'] as $u) {
                $lojasU = is_array($u['lojas'] ?? null) ? array_map('strval', $u['lojas']) : (($u['lojaId'] ?? '') ? [(string)$u['lojaId']] : []);
                if (!in_array($lojaId, $lojasU, true)) continue;
                if (!empty($u['ativo'])
                    && (mb_strtolower($u['usuario'] ?? '', 'UTF-8') === $lower
                        || mb_strtolower($u['nome'] ?? '', 'UTF-8') === $lower)
                    && hash_equals((string) ($u['senha'] ?? ''), $senha)) {
                    $match = $u;
                    break;
                }
            }
            if (!$match) {
                usleep(250000);
                fail('USUARIO_INVALIDO', 401);
            }
            respond([
                'ok' => true,
                'user' => userVisible($match),
                'loja' => ['id' => $loja['id'], 'nome' => $loja['nome'], 'pdv' => $loja['pdv']],
            ]);
        }

        case 'equipe': {
            $db = db();
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $loja = findLoja($db, $lojaId);
            if (!$loja) fail('LOJA_INVALIDA', 404);
            $users = array_values(array_filter($db['usuarios'], function ($u) use ($lojaId) {
                $lojasU = is_array($u['lojas'] ?? null) ? array_map('strval', $u['lojas']) : (($u['lojaId'] ?? '') ? [(string)$u['lojaId']] : []);
                return in_array($lojaId, $lojasU, true) && !empty($u['ativo']);
            }));
            respond([
                'ok' => true,
                'loja' => ['id' => $loja['id'], 'nome' => $loja['nome'], 'pdv' => $loja['pdv']],
                'usuarios' => array_map(function ($u) {
                    return userVisible($u);
                }, $users),
            ]);
        }

        // Wizard de 1º uso do PDV: o operador digita o NOME DO LOCAL no
        // kiosk; aqui guardamos um RASCUNHO por código (não cria loja —
        // senão o kiosk.pair casaria antes de o admin confirmar). O admin
        // depois cola o mesmo código no "Nova loja" do portal e a loja é
        // criada com este nome + a máquina já fica emparelhada.
        case 'kiosk.seed': {
            $db = db();
            $kioskCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['kioskCode'] ?? ''))));
            $nome = trim((string) ($p['nome'] ?? ''));
            $pdvNome = trim((string) ($p['pdvNome'] ?? ''));
            $machineId = trim((string) ($p['machineId'] ?? ''));
            if ($kioskCode === '' || $nome === '') fail('DADOS_INCOMPLETOS: kioskCode e nome são obrigatórios', 400);
            if (mb_strlen($nome, 'UTF-8') > 80) fail('NOME_INVALIDO', 400);

            // Já existe loja com este código? Então nada a fazer (pareamento
            // segue pelo kiosk.pair normal) — responde ok para o PDV parar.
            $existe = false;
            foreach ($db['lojas'] as $l) {
                if ((string) ($l['kioskCode'] ?? '') === $kioskCode) { $existe = true; break; }
            }
            if ($existe) {
                respond(['ok' => true, 'jaRegistrado' => true]);
            }

            usleep(200000); // leve trava de força-bruta (mesma linha dos atos de login)
            if (!isset($db['pendentes']) || !is_array($db['pendentes'])) $db['pendentes'] = [];
            $agora = gmdate('c');
            $atual = $db['pendentes'][$kioskCode] ?? null;
            $db['pendentes'][$kioskCode] = [
                'kioskCode' => $kioskCode,
                'nome' => $nome,
                'pdvNome' => $pdvNome,
                'machineId' => $machineId,
                'criadoEm' => is_array($atual) && !empty($atual['criadoEm']) ? $atual['criadoEm'] : $agora,
                'atualizadoEm' => $agora,
            ];
            saveDb($db);
            respond(['ok' => true, 'pendente' => $db['pendentes'][$kioskCode]]);
        }

        case 'kiosk.pair': {
            $db = db();
            $kioskCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['kioskCode'] ?? ''))));
            $pairingCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['pairingCode'] ?? ''))));
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $pdvNome = trim((string) ($p['pdvNome'] ?? ''));
            $machineId = trim((string) ($p['machineId'] ?? ''));

            // Fluxo principal: o kiosk envia o CÓDIGO que aparece na tela dele.
            // O admin digitou esse código na loja (campo "código do kiosk") —
            // nada de editar arquivo de config no kiosk.
            $loja = null;
            if ($kioskCode !== '') {
                foreach ($db['lojas'] as $l) {
                    if ((string) ($l['kioskCode'] ?? '') === $kioskCode) { $loja = $l; break; }
                }
                if (!$loja) fail('KIOSK_NAO_EMPARELELHADO', 404); // admin ainda não digitou este código numa loja
            } elseif ($lojaId !== '' && $pairingCode !== '') {
                // Legado: código gerado no portal e colocado no electron-config.json.
                $loja = findLoja($db, $lojaId);
                if (!$loja) fail('LOJA_INVALIDA', 404);
                if (!hash_equals((string) ($loja['pairingCode'] ?? ''), $pairingCode)) {
                    usleep(250000);
                    fail('CODIGO_INVALIDO', 401);
                }
            } else {
                fail('DADOS_INCOMPLETOS', 400);
            }

            if (empty($loja['ativo'])) fail('LOJA_INVALIDA', 404);

            // Bloqueia a mesmas máquina já emparelhada noutra loja (imagem clonada).
            foreach ($db['lojas'] as $l) {
                if (($l['id'] ?? '') === $loja['id']) continue;
                if ($machineId !== '' && !empty($l['pareamento']['machineId'])
                    && hash_equals((string) $l['pareamento']['machineId'], $machineId)) {
                    fail('MAQUINA_JA_EMPARELHADA', 409);
                }
            }

            $pareamento = [
                'pdvNome' => resolverPdvNome($pdvNome, $loja),
                'machineId' => $machineId,
                'emparelhadoEm' => gmdate('c'),
            ];
            foreach ($db['lojas'] as $i => $x) {
                if (($x['id'] ?? '') === $loja['id']) {
                    $db['lojas'][$i]['pareamento'] = $pareamento;
                    break;
                }
            }
            saveDb($db);
            respond([
                'ok' => true,
                'loja' => ['id' => $loja['id'], 'nome' => $loja['nome'], 'pdv' => $loja['pdv'], 'kioskCode' => $kioskCode],
                'pareamento' => $pareamento,
            ]);
        }

        case 'precos': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            respond([
                'ok' => true,
                'lojaId' => $lojaId,
                'precos' => precosEfetivos($lojaId),
                'catalogo' => catalogoEfetivo($lojaId),
            ]);
        }

        // Snapshot diário de vendas enviado pelo PDV (só aceita de máquina
        // pareada com a loja — protege contra push de dados de fora).
        case 'vendas.push': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $data = trim((string) ($p['data'] ?? ''));
            if ($lojaId === '' || $data === '') {
                fail('DADOS_INCOMPLETOS: lojaId e data são obrigatórios');
            }
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $data)) fail('DATA_INVALIDA');

            // autorização pela máquina (offline-first) → loja canônica do envio
            [$db, $loja] = validarLojaPareada($p);
            $lojaId = (string) ($loja['id'] ?? $lojaId);

            $meios = [];
            $rawMeios = is_array($p['meios'] ?? null) ? $p['meios'] : [];
            foreach (MEIOS_CONHECIDOS as $mk) {
                $meios[$mk] = round(max(0, (float) ($rawMeios[$mk] ?? 0)), 2);
            }
            $totalVendido = round(max(0, (float) ($p['totalVendido'] ?? 0)), 2);
            // Reconciliação: se a soma das formas não fecha com a receita do dia,
            // recalcula a partir dos pedidos REAIS que o próprio PDV já subiu
            // (fonte de verdade das formas). Assim a diferença nunca vira
            // "Não informado" por dessincronia do snapshot. Só usa os pedidos
            // quando eles cobrem o dia inteiro — snapshot parcial não corrige.
            $somaMeios = round(array_sum($meios), 2);
            if ($somaMeios + 0.005 < $totalVendido) {
                $pedidosDia = [];
                $todosPedidos = loadJson('pedidos.json', []);
                if (is_array($todosPedidos)) {
                    foreach ($todosPedidos as $pd) {
                        if (!is_array($pd)) continue;
                        if (($pd['lojaId'] ?? '') !== $lojaId) continue;
                        if (($pd['data'] ?? '') !== $data) continue;
                        $st = strtolower(trim((string) ($pd['status'] ?? '')));
                        if ($st !== 'pago' && $st !== 'impresso') continue;
                        $pedidosDia[] = $pd;
                    }
                }
                $totalDia = 0.0;
                foreach ($pedidosDia as $pd) $totalDia += (float) ($pd['total'] ?? 0);
                $totalDia = round($totalDia, 2);
                if ($pedidosDia && $totalDia > 0 && abs($totalDia - $totalVendido) <= 0.005) {
                    $pgsDia = [];
                    foreach ($pedidosDia as $pd) {
                        foreach ((array) ($pd['pagamentos'] ?? []) as $pg) {
                            if (is_array($pg)) $pgsDia[] = $pg;
                        }
                    }
                    $meiosRec = somaMeios($pgsDia);
                    if (round(array_sum($meiosRec), 2) + 0.005 >= $totalVendido) {
                        $meios = $meiosRec;
                        $somaMeios = round(array_sum($meios), 2);
                    }
                }
            }
            $snap = [
                'lojaId' => $lojaId,
                'lojaNome' => lojaNomePush($p, $loja),
                'pdvNome' => resolverPdvNome($p['pdvNome'], $loja),
                'machineId' => trim((string) ($p['machineId'] ?? '')),
                'data' => $data,
                'totalVendido' => $totalVendido,
                'pedidos' => max(0, (int) ($p['pedidos'] ?? 0)),
                'sessoesCriadas' => max(0, (int) ($p['sessoesCriadas'] ?? 0)),
                'sessoesVendidas' => max(0, (int) ($p['sessoesVendidas'] ?? 0)),
                'taxacombo' => round(min(100, max(0, (float) ($p['taxacombo'] ?? 0))), 1),
                'ribbonRestante' => (isset($p['ribbonRestante']) && $p['ribbonRestante'] !== '' && $p['ribbonRestante'] !== null)
                    ? max(0, (int) $p['ribbonRestante']) : null,
                'papel10x15' => (isset($p['papel10x15']) && $p['papel10x15'] !== '' && $p['papel10x15'] !== null)
                    ? max(0, (int) $p['papel10x15']) : null,
                'papel15x20' => (isset($p['papel15x20']) && $p['papel15x20'] !== '' && $p['papel15x20'] !== null)
                    ? max(0, (int) $p['papel15x20']) : null,
                'meios' => $meios,
                'ultimaVenda' => $p['ultimaVenda'] ?? null,
                'caixa' => (isset($p['caixa']) && is_array($p['caixa']))
                    ? ['numero' => (string) ($p['caixa']['numero'] ?? ''), 'aberto' => !empty($p['caixa']['aberto'])]
                    : null,
                'enviadoEm' => gmdate('c'),
            ];

            $vendas = loadJson('vendas.json', []);
            if (!is_array($vendas)) $vendas = [];
            $found = null;
            foreach ($vendas as $i => $v) {
                if (($v['lojaId'] ?? '') === $lojaId && ($v['data'] ?? '') === $data) { $found = $i; break; }
            }
            if ($found !== null) $vendas[$found] = $snap; else $vendas[] = $snap;
            saveJson('vendas.json', $vendas);
            respond(['ok' => true, 'snapshot' => $snap]);
        }

        // Pedido a pedido (PDV → portal), idempotente pelo id do pedido
        // (reaenvio simplesmente sobrescreve — mesmo comportamento do upsert
        // do snapshot). É o que alimenta as telas Pedidos, Ranking e o DRE do
        // portal com o que de fato aconteceu no balcão.
        case 'pedido.push': {
            [$db, $loja] = validarLojaPareada($p);
            $pd = $p['pedido'] ?? null;
            if (!is_array($pd)) fail('DADOS_INCOMPLETOS: pedido é obrigatório');
            $id = trim((string) ($pd['id'] ?? ''));
            if ($id === '') fail('DADOS_INCOMPLETOS: pedido.id é obrigatório');

            $itens = [];
            foreach ((array) ($pd['itens'] ?? []) as $it) {
                if (!is_array($it)) continue;
                $itens[] = [
                    'tipo' => trim((string) ($it['tipo'] ?? 'tamanho')),
                    'produtoId' => trim((string) ($it['produtoId'] ?? '')),
                    'label' => trim((string) ($it['label'] ?? '')),
                    'qtd' => max(0, (int) ($it['qtd'] ?? 1)),
                    'unidades' => max(0, (int) ($it['unidades'] ?? 0)),
                    // preço/subtotal podem ser negativos (desconto de combo, ajustes)
                    'precoUnit' => round((float) ($it['precoUnit'] ?? 0), 2),
                    'subtotal' => round((float) ($it['subtotal'] ?? 0), 2),
                ];
            }
            $pagamentos = [];
            foreach ((array) ($pd['pagamentos'] ?? []) as $pg) {
                if (!is_array($pg)) continue;
                $pl = null;
                $meio = normalizarMeioPagamento($pg['meio'] ?? '', $pg['forma'] ?? '', $pl);
                $forma = trim((string) ($pg['forma'] ?? ''));
                if ($forma === '' || $forma === '—') $forma = $meio;
                $parcelas = (int) ($pg['parcelas'] ?? 0) ?: (int) ($pl ?? 0);
                $pagamentos[] = [
                    'meio' => $meio,
                    'forma' => $forma,
                    'valor' => round(max(0, (float) ($pg['valor'] ?? 0)), 2),
                    'parcelas' => max(0, $parcelas),
                ];
            }
            $registro = [
                'id' => $id,
                'numero' => (string) ($pd['numero'] ?? $id),
                'lojaId' => $loja['id'],
                'lojaNome' => lojaNomePush($p, $loja),
                'pdvNome' => resolverPdvNome($pd['pdvNome'], $loja),
                'machineId' => trim((string) ($p['machineId'] ?? '')),
                'data' => trim((string) ($pd['data'] ?? '')),
                'criadoEm' => (string) ($pd['criadoEm'] ?? gmdate('c')),
                'pagoEm' => (string) ($pd['pagoEm'] ?? ''),
                'total' => round(max(0, (float) ($pd['total'] ?? 0)), 2),
                'status' => trim((string) ($pd['status'] ?? 'pago')),
                'operador' => trim((string) ($pd['operador'] ?? '—')),
                'unidadesTotal' => array_sum(array_column($itens, 'unidades')),
                'itens' => $itens,
                'pagamentos' => $pagamentos,
                'sessoes' => is_array($pd['sessoes'] ?? null) ? array_values($pd['sessoes']) : [],
                'desconto' => round(max(0, (float) ($pd['desconto'] ?? 0)), 2),
                'caixaId' => (string) ($pd['caixaId'] ?? ''),
                'origemPedidoId' => (string) ($pd['origemPedidoId'] ?? ''),
                'guiaImpressa' => !empty($pd['guiaImpressa']),
                'enviadoEm' => gmdate('c'),
            ];

            $todos = loadJson('pedidos.json', []);
            if (!is_array($todos)) $todos = [];
            $found = null;
            foreach ($todos as $i => $r) {
                if (($r['id'] ?? '') === $id) { $found = $i; break; }
            }
            if ($found !== null) $todos[$found] = $registro; else $todos[] = $registro;
            saveJson('pedidos.json', $todos);
            respond(['ok' => true, 'pedido' => $registro]);
        }

        // Uso de senha master (PDV → portal), idempotente pelo id. Alimenta a
        // tela Auditoria: perda, desconto/cancelamento, cobrança de diferença.
        case 'auditoria.push': {
            [$db, $loja] = validarLojaPareada($p);
            $u = $p['uso'] ?? null;
            if (!is_array($u)) fail('DADOS_INCOMPLETOS: uso é obrigatório');
            $id = trim((string) ($u['id'] ?? ''));
            if ($id === '') fail('DADOS_INCOMPLETOS: uso.id é obrigatório');

            $registro = [
                'id' => $id,
                'lojaId' => $loja['id'],
                'lojaNome' => lojaNomePush($p, $loja),
                'pdvNome' => trim((string) ($u['pdvNome'] ?? ($loja['pdv'] ?? ''))),
                'machineId' => trim((string) ($p['machineId'] ?? '')),
                'data' => trim((string) ($u['data'] ?? gmdate('Y-m-d'))),
                'criadoEm' => (string) ($u['criadoEm'] ?? gmdate('c')),
                'titulo' => trim((string) ($u['titulo'] ?? 'Uso de senha master')),
                'operador' => trim((string) ($u['operador'] ?? '—')),
                'motivo' => trim((string) ($u['motivo'] ?? '')),
                'pedidoContexto' => (string) ($u['pedidoContexto'] ?? ''),
                'pedidoGeradoId' => (string) ($u['pedidoGeradoId'] ?? ''),
                'enviadoEm' => gmdate('c'),
            ];

            $todos = loadJson('auditoria.json', []);
            if (!is_array($todos)) $todos = [];
            $found = null;
            foreach ($todos as $i => $r) {
                if (($r['id'] ?? '') === $id) { $found = $i; break; }
            }
            if ($found !== null) $todos[$found] = $registro; else $todos[] = $registro;
            saveJson('auditoria.json', $todos);
            respond(['ok' => true, 'uso' => $registro]);
        }

        case 'admin.login': {
            $senha = (string) ($p['senha'] ?? '');
            if (!hash_equals(adminHash(), sha256($senha))) {
                usleep(250000);
                fail('SENHA_INVALIDA', 401);
            }
            respond(['ok' => true, 'token' => createToken(), 'expiraEm' => 12 * 3600]);
        }

        default:
            break;
    }

    // ── Administrativas (exigem token válido) ───────────────
    if ($action !== '' && !checkToken($token)) fail('TOKEN_INVALIDO', 401);

    switch ($action) {
        case 'lojas.list': {
            $lojas = db()['lojas'];
            $cx = conexaoPorLoja();
            foreach ($lojas as &$l) {
                $id = (string) ($l['id'] ?? '');
                $c = $cx[$id] ?? ['ultimaConexao' => '', 'conexaoDelta' => null, 'online' => false];
                $l['ultimaConexao'] = $c['ultimaConexao'];
                $l['conexaoDelta'] = $c['conexaoDelta'];
                $l['online'] = $c['online'];
            }
            unset($l);
            respond(['ok' => true, 'lojas' => array_values($lojas)]);
        }

        case 'lojas.save': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            $nome = trim((string) ($p['nome'] ?? ''));
            $pdv = trim((string) ($p['pdv'] ?? ''));
            $kioskCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['kioskCode'] ?? ''))));

            // ── Wizard de 1º uso: loja criada só com o CÓDIGO ──────────────
            // O admin colou o código que aparece na tela do PDV; o nome/pdv/
            // máquina vêm do rascunho gravado pelo kiosk.seed. O id nasce do
            // slug do nome (royal-plaza, royal-plaza-2...). O pareamento é
            // gravado agora — o PDV é autorizado sem esperar o próximo poll.
            if ($id === '' && $nome === '' && $kioskCode !== '') {
                $pend = $db['pendentes'][$kioskCode] ?? null;
                if (!is_array($pend) || empty($pend['nome'])) {
                    usleep(250000);
                    fail('RASCUNHO_NAO_ENCONTRADO: nenhum PDV registrou este código — cadastre a loja manualmente', 404);
                }
                $nome = trim((string) $pend['nome']);
                $pdv = trim((string) ($pend['pdvNome'] ?? '')) ?: $pdv;
                $id = slugLoja($nome);
                $base = $id;
                $n = 2;
                while (findLoja($db, $id) !== null) { $id = $base . '-' . $n; $n++; }

                $loja = [
                    'id' => $id,
                    'nome' => $nome,
                    'pdv' => $pdv,
                    'pairingCode' => strtoupper(substr(bin2hex(random_bytes(8)), 0, 8)),
                    'kioskCode' => $kioskCode,
                    'ativo' => true,
                ];
                $machineId = trim((string) ($pend['machineId'] ?? ''));
                if ($machineId !== '') {
                    // Mesma trava de clone do kiosk.pair: uma máquina só numa loja.
                    foreach ($db['lojas'] as $l) {
                        if (($l['id'] ?? '') === $id) continue;
                        if (!empty($l['pareamento']['machineId'])
                            && hash_equals((string) $l['pareamento']['machineId'], $machineId)) {
                            fail('MAQUINA_JA_EMPARELHADA', 409);
                        }
                    }
                    $loja['pareamento'] = [
                        'pdvNome' => $pdv,
                        'machineId' => $machineId,
                        'emparelhadoEm' => gmdate('c'),
                    ];
                }
                $db['lojas'][] = $loja;
                unset($db['pendentes'][$kioskCode]);
                saveDb($db);
                respond(['ok' => true, 'loja' => $loja, 'criada' => true]);
            }

            if ($id === '' || $nome === '') {
                fail('DADOS_INCOMPLETOS: id e nome são obrigatórios');
            }

            $anterior = null;
            foreach ($db['lojas'] as $i => $l) {
                if (($l['id'] ?? '') === $id) { $anterior = ['i' => $i, 'loja' => $l]; break; }
            }

            // Código de emparelhamento (legado, gerado no admin): aceita o enviado,
            // senão mantém o existente (edição) ou gera um novo (cadastro).
            $pairingCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['pairingCode'] ?? ''))));
            if ($pairingCode === '') {
                $pairingCode = $anterior ? (string) ($anterior['loja']['pairingCode'] ?? '') : '';
            }
            if ($pairingCode === '') {
                $pairingCode = strtoupper(substr(bin2hex(random_bytes(8)), 0, 8));
            }

            // Código do kiosk (é o que aparece na TELA do PDV — o admin digita aqui).
            // Cadastro: pode ficar vazio (preencher depois que o kiosk exibir o código).
            if ($kioskCode === '' && $anterior) {
                $kioskCode = (string) ($anterior['loja']['kioskCode'] ?? '');
            }

            // Não deixa duas lojas usarem o mesmo código (de emparelhamento ou de kiosk).
            foreach ($db['lojas'] as $j => $l) {
                if ($anterior && $j === $anterior['i']) continue;
                $outro = (string) ($l['pairingCode'] ?? '');
                if ($outro !== '' && $pairingCode !== '' && hash_equals($outro, $pairingCode)) {
                    fail('CODIGO_EM_USO', 409);
                }
                $outroK = (string) ($l['kioskCode'] ?? '');
                if ($kioskCode !== '' && $outroK !== '' && hash_equals($outroK, $kioskCode)) {
                    fail('CODIGO_EM_USO — este código do kiosk já está em outra loja', 409);
                }
            }

            $loja = [
                'id' => $id,
                'nome' => $nome,
                'pdv' => $pdv,
                'pairingCode' => $pairingCode,
                'kioskCode' => $kioskCode,
                'ativo' => !empty($p['ativo']),
            ];
            if ($anterior) {
                if (isset($anterior['loja']['pareamento'])) $loja['pareamento'] = $anterior['loja']['pareamento'];
                $db['lojas'][$anterior['i']] = $loja;
            } else {
                $db['lojas'][] = $loja;
            }
            // Cadastro manual com o mesmo código do wizard → consome o rascunho
            // (senão sobra em `pendentes` pra sempre).
            if ($kioskCode !== '' && isset($db['pendentes'][$kioskCode])) {
                unset($db['pendentes'][$kioskCode]);
            }
            saveDb($db);
            respond(['ok' => true, 'loja' => $loja]);
        }

        case 'lojas.delete': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            $before = count($db['lojas']);
            $db['lojas'] = array_values(array_filter($db['lojas'], function ($l) use ($id) {
                return ($l['id'] ?? '') !== $id;
            }));
            if (count($db['lojas']) === $before) fail('LOJA_NAO_ENCONTRADA', 404);
            saveDb($db);
            respond(['ok' => true]);
        }

        case 'precos.save': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $enviados = $p['precos'] ?? null;
            $temCatalogo = array_key_exists('catalogo', $p);
            if ($lojaId === '' || (!$temCatalogo && !is_array($enviados))) {
                fail('DADOS_INCOMPLETOS: lojaId e precos/catalogo são obrigatórios');
            }
            $catalogo = null;
            if ($temCatalogo) {
                $catalogo = sanitizarCatalogo($p['catalogo']);
                if ($catalogo === null) {
                    fail('CATALOGO_INVALIDO: informe pelo menos os tamanhos 10x15 e 15x20 e combos com itens válidos');
                }
            }
            $dados = loadJson('precos.json', []);
            if (!is_array($dados)) $dados = [];
            $sanitizado = [];
            if (is_array($enviados)) {
                foreach (PRECOS_DEFAULT as $k => $v) {
                    if (!array_key_exists($k, $enviados)) continue;
                    if (is_numeric($enviados[$k]) && (float) $enviados[$k] >= 0) {
                        $sanitizado[$k] = round((float) $enviados[$k], 2);
                    }
                }
            }
            if ($catalogo !== null) {
                // Preços embutidos no catálogo viram o overlay "flat" das chaves
                // oficiais — mantém compatibilidade com PDVs antigos, que só
                // conhecem o mapa de preços.
                $flat = [];
                foreach ($catalogo['tamanhos'] as $it) {
                    if (array_key_exists($it['id'], PRECOS_DEFAULT)) $flat[$it['id']] = $it['preco'];
                }
                foreach ($catalogo['extras'] as $it) {
                    if (array_key_exists($it['id'], PRECOS_DEFAULT)) $flat[$it['id']] = $it['preco'];
                }
                foreach ($catalogo['combos'] as $it) {
                    if (array_key_exists($it['id'], PRECOS_DEFAULT)) $flat[$it['id']] = $it['valorCombo'];
                }
                $dados[$lojaId] = array_merge($flat, $sanitizado);
                $dados[$lojaId]['__catalogo'] = $catalogo;
            } else {
                $dados[$lojaId] = $sanitizado; // vazio = resetar para os defaults oficiais
            }
            saveJson('precos.json', $dados);
            respond([
                'ok' => true,
                'precos' => precosEfetivos($lojaId),
                'catalogo' => catalogoEfetivo($lojaId),
            ]);
        }

        // Overlay bruto de preços por loja (admin) — usado no backup/restauração
        // da gestão. Sem token não é exposto (o público só vê precosEfetivos).
        case 'precos.list': {
            $dados = loadJson('precos.json', []);
            if (!is_array($dados)) $dados = [];
            respond(['ok' => true, 'precos' => $dados, 'defaults' => PRECOS_DEFAULT, 'catalogoDefault' => CATALOGO_DEFAULT]);
        }

        case 'vendas.resumo': {
            $todas = loadJson('vendas.json', []);
            if (!is_array($todas)) $todas = [];
            usort($todas, function ($a, $b) {
                return strcmp((string) ($b['data'] ?? ''), (string) ($a['data'] ?? ''))
                    ?: strcmp((string) ($a['lojaId'] ?? ''), (string) ($b['lojaId'] ?? ''));
            });
            respond(['ok' => true, 'vendas' => array_values($todas)]);
        }

        // Pedidos consolidados de todas as lojas (enviados pedido a pedido pelo
        // PDV em pedido.push) — tela "Pedidos" e base do DRE/Ranking.
        case 'pedido.list': {
            $todos = loadJson('pedidos.json', []);
            if (!is_array($todos)) $todos = [];
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $dataIni = trim((string) ($p['dataIni'] ?? ''));
            $dataFim = trim((string) ($p['dataFim'] ?? ''));
            $q = mb_strtolower(trim((string) ($p['q'] ?? '')), 'UTF-8');
            $status = mb_strtolower(trim((string) ($p['status'] ?? '')), 'UTF-8');
            $out = [];
            foreach ($todos as $r) {
                if ($lojaId !== '' && ($r['lojaId'] ?? '') !== $lojaId) continue;
                if ($dataIni !== '' && ($r['data'] ?? '') < $dataIni) continue;
                if ($dataFim !== '' && ($r['data'] ?? '') > $dataFim) continue;
                if ($status !== '' && mb_strtolower((string) ($r['status'] ?? ''), 'UTF-8') !== $status) continue;
                if ($q !== '') {
                    $hay = mb_strtolower((string) ($r['numero'] ?? '') . ' ' . ($r['lojaNome'] ?? '') . ' ' . ($r['operador'] ?? '') . ' ' . ($r['id'] ?? ''), 'UTF-8');
                    if (mb_strpos($hay, $q) === false) continue;
                }
                $out[] = $r;
            }
            usort($out, function ($a, $b) {
                return strcmp((string) ($b['criadoEm'] ?? ''), (string) ($a['criadoEm'] ?? ''))
                    ?: strcmp((string) ($b['numero'] ?? ''), (string) ($a['numero'] ?? '')) ?: 0;
            });
            $totalLiquido = 0;
            foreach ($out as $r) {
                if (!in_array($r['status'] ?? '', ['cancelado', 'CANCELADO'], true)) $totalLiquido += (float) ($r['total'] ?? 0);
            }
            respond(['ok' => true, 'pedidos' => array_values($out), 'total' => count($out), 'totalLiquido' => round($totalLiquido, 2)]);
        }

        // Usos de senha master de todas as lojas — tela "Auditoria".
        case 'auditoria.list': {
            $todos = loadJson('auditoria.json', []);
            if (!is_array($todos)) $todos = [];
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $dataIni = trim((string) ($p['dataIni'] ?? ''));
            $dataFim = trim((string) ($p['dataFim'] ?? ''));
            $out = [];
            foreach ($todos as $r) {
                if ($lojaId !== '' && ($r['lojaId'] ?? '') !== $lojaId) continue;
                if ($dataIni !== '' && ($r['data'] ?? '') < $dataIni) continue;
                if ($dataFim !== '' && ($r['data'] ?? '') > $dataFim) continue;
                $out[] = $r;
            }
            usort($out, function ($a, $b) {
                return strcmp((string) ($b['criadoEm'] ?? ''), (string) ($a['criadoEm'] ?? '')) ?: 0;
            });
            respond(['ok' => true, 'auditoria' => array_values($out), 'usos' => array_values($out)]);
        }

        // Parâmetros globais (DRE/estoque) — leitura e gravação pela gestão.
        case 'parametros.get':
            respond(['ok' => true, 'parametros' => parametrosEfetivos()]);

        case 'parametros.save': {
            $enviados = array_intersect_key((array) $p, PARAMS_DEFAULT);
            if (!$enviados) fail('DADOS_INCOMPLETOS: nenhum parâmetro válido informado');
            $saved = parametrosEfetivos();
            foreach (PARAMS_DEFAULT as $k => $v) {
                $val = $p[$k] ?? null;
                if (!is_numeric($val) || (float) $val < 0) continue;
                if ($k === 'custoRibbonUnitario') $saved[$k] = round((float) $val, 2);
                elseif ($k === 'ribbonCritico') $saved[$k] = round(max(0, (float) $val), 0);
                else $saved[$k] = min(100, (float) $val); // comissões em %
            }
            saveJson('parametros.json', $saved);
            respond(['ok' => true, 'parametros' => parametrosEfetivos()]);
        }

        // Despesas lançadas manualmente pela gestão (não vêm do PDV).
        case 'despesas.list': {
            $todas = loadJson('despesas.json', []);
            if (!is_array($todas)) $todas = [];
            usort($todas, function ($a, $b) {
                return strcmp((string) ($b['data'] ?? ''), (string) ($a['data'] ?? ''))
                    ?: strcmp((string) ($a['lojaId'] ?? ''), (string) ($b['lojaId'] ?? ''));
            });
            respond(['ok' => true, 'despesas' => array_values($todas)]);
        }

        case 'despesas.save': {
            $id = trim((string) ($p['id'] ?? ''));
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $data = trim((string) ($p['data'] ?? ''));
            $categoria = trim((string) ($p['categoria'] ?? ''));
            $descricao = trim((string) ($p['descricao'] ?? ''));
            $valor = (float) ($p['valor'] ?? 0);
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $data)) fail('DATA_INVALIDA');
            if ($categoria === '' || $valor <= 0) fail('DADOS_INCOMPLETOS: categoria e valor são obrigatórios');

            $todas = loadJson('despesas.json', []);
            if (!is_array($todas)) $todas = [];
            $encontrada = null;
            if ($id !== '') {
                foreach ($todas as $i => $d) {
                    if (($d['id'] ?? '') === $id) { $encontrada = $i; break; }
                }
            }
            $nova = [
                'id' => $id !== '' ? $id : 'DESP-' . strtoupper(substr(bin2hex(random_bytes(4)), 0, 8)),
                'lojaId' => $lojaId,
                'data' => $data,
                'categoria' => $categoria,
                'descricao' => $descricao,
                'valor' => round(max(0, $valor), 2),
                'criadoEm' => gmdate('c'),
            ];
            if ($encontrada !== null) $todas[$encontrada] = $nova; else $todas[] = $nova;
            saveJson('despesas.json', $todas);
            respond(['ok' => true, 'despesa' => $nova]);
        }

        case 'despesas.delete': {
            $id = trim((string) ($p['id'] ?? ''));
            $todas = loadJson('despesas.json', []);
            if (!is_array($todas)) $todas = [];
            $antes = count($todas);
            $todas = array_values(array_filter($todas, function ($d) use ($id) {
                return ($d['id'] ?? '') !== $id;
            }));
            if (count($todas) === $antes) fail('DESPESA_NAO_ENCONTRADA', 404);
            saveJson('despesas.json', $todas);
            respond(['ok' => true]);
        }

        case 'usuarios.list': {
            $db = db();
            $lojaId = (string) ($p['lojaId'] ?? '');
            $users = array_map(function ($u) {
                return userVisible($u, true);
            }, $db['usuarios']);
            if ($lojaId !== '') {
                $users = array_values(array_filter($users, function ($u) use ($lojaId) {
                    $lojas = $u['lojas'] ?? (($u['lojaId'] ?? '') ? [$u['lojaId']] : []);
                    return in_array($lojaId, $lojas, true);
                }));
            }
            respond(['ok' => true, 'usuarios' => $users]);
        }

        case 'usuarios.save': {
            $db = db();
            $id = (string) ($p['id'] ?? '');
            $lojas = null;
            if (isset($p['lojas']) && is_array($p['lojas'])) {
                $lojas = array_values(array_filter(array_map(function ($v) {
                    $s = trim((string) $v); return $s === '' ? null : $s;
                }, $p['lojas']), function ($v) { return $v !== null; }));
                $lojas = array_values(array_unique($lojas));
            }
            $lojaId = trim((string) ($p['lojaId'] ?? ($lojas[0] ?? '')));
            if (!$lojas || count($lojas) === 0) $lojas = $lojaId !== '' ? [$lojaId] : [];

            $u = [
                'id' => $id,
                'lojaId' => $lojaId,
                'lojas' => $lojas,
                'usuario' => trim((string) ($p['usuario'] ?? '')),
                'nome' => trim((string) ($p['nome'] ?? '')),
                'funcao' => trim((string) ($p['funcao'] ?? 'vendedor')),
                'senha' => (string) ($p['senha'] ?? ''),
                'ativo' => !empty($p['ativo']),
            ];
            if (count($lojas) === 0 || $u['usuario'] === '' || $u['nome'] === '' || $u['senha'] === '') {
                fail('DADOS_INCOMPLETOS: loja/lojas, usuário, nome e senha são obrigatórios');
            }
            if (!in_array($u['funcao'], FUNCOES(), true)) fail('FUNCAO_INVALIDA');
            foreach ($lojas as $l) if (!findLoja($db, $l)) fail('LOJA_INVALIDA', 404);

            $duplicado = function ($users, $i, $lojaId, $usuario) {
                foreach ($users as $j => $y) {
                    if ($j === $i) continue;
                    $yl = $y['lojas'] ?? (($y['lojaId'] ?? '') ? [$y['lojaId']] : []);
                    if (in_array($lojaId, $yl, true)
                        && mb_strtolower($y['usuario'] ?? '') === mb_strtolower($usuario)) {
                        return true;
                    }
                }
                return false;
            };

            foreach ($db['usuarios'] as $i => $x) {
                if (($x['id'] ?? '') === $u['id']) {
                    foreach ($lojas as $l) {
                        if ($duplicado($db['usuarios'], $i, $l, $u['usuario'])) fail('USUARIO_DUPLICADO');
                    }
                    $db['usuarios'][$i] = $u;
                    saveDb($db);
                    respond(['ok' => true, 'usuario' => userVisible($u, true)]);
                }
            }
            foreach ($lojas as $l) {
                if ($duplicado($db['usuarios'], -1, $l, $u['usuario'])) fail('USUARIO_DUPLICADO');
            }
            $u['id'] = uid();
            $db['usuarios'][] = $u;
            saveDb($db);
            respond(['ok' => true, 'usuario' => userVisible($u, true)]);
        }

        case 'usuarios.delete': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            $before = count($db['usuarios']);
            $db['usuarios'] = array_values(array_filter($db['usuarios'], function ($x) use ($id) {
                return ($x['id'] ?? '') !== $id;
            }));
            if (count($db['usuarios']) === $before) fail('USUARIO_NAO_ENCONTRADO', 404);
            saveDb($db);
            respond(['ok' => true]);
        }

        case 'admin.changePassword': {
            $atual = (string) ($p['senhaAtual'] ?? '');
            $nova = (string) ($p['novaSenha'] ?? '');
            if (strlen($nova) < 4) fail('SENHA_CURTA');
            if (!hash_equals(adminHash(), sha256($atual))) fail('SENHA_ATUAL_INVALIDA', 401);
            saveJson('admin.json', ['hash' => sha256($nova)]);
            respond(['ok' => true]);
        }

        default:
            fail('ACAO_DESCONHECIDA', 404);
    }
} catch (Throwable $e) {
    fail('ERRO_INTERNO: ' . $e->getMessage(), 500);
}