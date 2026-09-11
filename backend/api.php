<?php
/**
 * Maxx Natal Controller — API de cadastro (lojas, vendedores, fotógrafos).
 * Backend single-file para hospedagem compartilhada (PHP 7.4+/8.x).
 * Dados em JSON sob /data (bloqueado na web via .htaccess).
 *
 * Ações públicas : health, login, equipe, kiosk.pair, precos, vendas.push,
 *                  pedido.push, auditoria.push
 * Ações admin    : exigem X-Token (header) ou campo "token":
 *   admin.login, lojas.list, lojas.save, lojas.delete,
 *   usuarios.list, usuarios.save, usuarios.delete, admin.changePassword,
 *   precos.save, vendas.resumo, pedido.list, auditoria.list,
 *   despesas.list, despesas.save, despesas.delete,
 *   parametros.get, parametros.save
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
    return is_array($data) ? $data : $default;
}

function saveJson(string $name, array $data): bool
{
    $path = dataFile($name);
    $fp = @fopen($path . '.lock', 'c');
    if ($fp) flock($fp, LOCK_EX);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $ok = @file_put_contents($path, $json, LOCK_EX) !== false;
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

function db(): array
{
    $data = loadJson('app.json', null);
    if (!$data) {
        $data = seed();
        saveJson('app.json', $data);
    }
    return $data;
}

function saveDb(array $data): bool
{
    return saveJson('app.json', $data);
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

// Valida que o kiosk que está chamando é a máquina pareada com a loja
// (pedido.push / auditoria.push / vendas.push). Protege contra push de dados
// de fora: só a máquina física daquela loja consegue mandar.
function validarLojaPareada(array $p): array
{
    $lojaId = trim((string) ($p['lojaId'] ?? ''));
    $machineId = trim((string) ($p['machineId'] ?? ''));
    if ($lojaId === '' || $machineId === '') {
        fail('DADOS_INCOMPLETOS: lojaId e machineId são obrigatórios');
    }
    $db = db();
    $loja = findLoja($db, $lojaId);
    if (!$loja || empty($loja['ativo'])) fail('LOJA_INVALIDA', 404);
    if ((string) ($loja['pareamento']['machineId'] ?? '') !== $machineId) {
        usleep(200000);
        fail('LOJA_NAO_EMPARELELHADA', 403);
    }
    return [$db, $loja];
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
    $out = [
        'id' => $u['id'] ?? '',
        'lojaId' => $u['lojaId'] ?? '',
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

// Parâmetros globais da operação (Portal define, DRE/Estoque consomem).
// custoRibbonUnitario = custo real por unidade de ribbon (impressa) — usado
// no DRE em vez do 18% fixo do protótipo; comissaoVendedor/Fotografo = % sobre
// as vendas do operador (custo de equipe); ribbonCritico = limite p/ alerta.
const PARAMS_DEFAULT = [
    'custoRibbonUnitario' => 0.0,
    'comissaoVendedor' => 0.0,
    'comissaoFotografo' => 0.0,
    'ribbonCritico' => 100.0,
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
                if (($u['lojaId'] ?? '') !== $lojaId) continue;
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
                return ($u['lojaId'] ?? '') === $lojaId && !empty($u['ativo']);
            }));
            respond([
                'ok' => true,
                'loja' => ['id' => $loja['id'], 'nome' => $loja['nome'], 'pdv' => $loja['pdv']],
                'usuarios' => array_map(function ($u) {
                    return userVisible($u);
                }, $users),
            ]);
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
                'pdvNome' => $pdvNome,
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
            respond(['ok' => true, 'lojaId' => $lojaId, 'precos' => precosEfetivos($lojaId)]);
        }

        // Snapshot diário de vendas enviado pelo PDV (só aceita de máquina
        // pareada com a loja — protege contra push de dados de fora).
        case 'vendas.push': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $machineId = trim((string) ($p['machineId'] ?? ''));
            $data = trim((string) ($p['data'] ?? ''));
            if ($lojaId === '' || $machineId === '' || $data === '') {
                fail('DADOS_INCOMPLETOS: lojaId, machineId e data são obrigatórios');
            }
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $data)) fail('DATA_INVALIDA');

            $db = db();
            $loja = findLoja($db, $lojaId);
            if (!$loja || empty($loja['ativo'])) fail('LOJA_INVALIDA', 404);
            if ((string) ($loja['pareamento']['machineId'] ?? '') !== $machineId) {
                usleep(200000);
                fail('LOJA_NAO_EMPARELELHADA', 403);
            }

            $meios = [];
            foreach (['dinheiro', 'debito', 'credito', 'pix'] as $mk) {
                $meios[$mk] = round(max(0, (float) ($p['meios'][$mk] ?? 0)), 2);
            }
            $snap = [
                'lojaId' => $lojaId,
                'lojaNome' => (string) ($loja['nome'] ?? $lojaId),
                'pdvNome' => trim((string) ($p['pdvNome'] ?? ($loja['pdv'] ?? ''))),
                'machineId' => $machineId,
                'data' => $data,
                'totalVendido' => round(max(0, (float) ($p['totalVendido'] ?? 0)), 2),
                'pedidos' => max(0, (int) ($p['pedidos'] ?? 0)),
                'sessoesCriadas' => max(0, (int) ($p['sessoesCriadas'] ?? 0)),
                'sessoesVendidas' => max(0, (int) ($p['sessoesVendidas'] ?? 0)),
                'taxacombo' => round(min(100, max(0, (float) ($p['taxacombo'] ?? 0))), 1),
                'ribbonRestante' => max(0, (int) ($p['ribbonRestante'] ?? 0)),
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
                    'precoUnit' => round(max(0, (float) ($it['precoUnit'] ?? 0)), 2),
                    'subtotal' => round(max(0, (float) ($it['subtotal'] ?? 0)), 2),
                ];
            }
            $pagamentos = [];
            foreach ((array) ($pd['pagamentos'] ?? []) as $pg) {
                if (!is_array($pg)) continue;
                $pagamentos[] = [
                    'meio' => trim((string) ($pg['meio'] ?? '')),
                    'forma' => trim((string) ($pg['forma'] ?? '')),
                    'valor' => round(max(0, (float) ($pg['valor'] ?? 0)), 2),
                    'parcelas' => max(0, (int) ($pg['parcelas'] ?? 0)),
                ];
            }
            $registro = [
                'id' => $id,
                'numero' => (string) ($pd['numero'] ?? $id),
                'lojaId' => $loja['id'],
                'lojaNome' => (string) ($loja['nome'] ?? $loja['id']),
                'pdvNome' => trim((string) ($pd['pdvNome'] ?? ($loja['pdv'] ?? ''))),
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
                'lojaNome' => (string) ($loja['nome'] ?? $loja['id']),
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
            $kioskCode = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) ($p['kioskCode'] ?? ''))));
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
            if ($lojaId === '' || !is_array($enviados)) {
                fail('DADOS_INCOMPLETOS: lojaId e precos são obrigatórios');
            }
            $dados = loadJson('precos.json', []);
            if (!is_array($dados)) $dados = [];
            $sanitizado = [];
            foreach (PRECOS_DEFAULT as $k => $v) {
                if (!array_key_exists($k, $enviados)) continue;
                if (is_numeric($enviados[$k]) && (float) $enviados[$k] >= 0) {
                    $sanitizado[$k] = round((float) $enviados[$k], 2);
                }
            }
            $dados[$lojaId] = $sanitizado; // vazio = resetar para os defaults oficiais
            saveJson('precos.json', $dados);
            respond(['ok' => true, 'precos' => precosEfetivos($lojaId)]);
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
            $status = trim((string) ($p['status'] ?? ''));
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
            respond(['ok' => true, 'usos' => array_values($out)]);
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
                    return $u['lojaId'] === $lojaId;
                }));
            }
            respond(['ok' => true, 'usuarios' => $users]);
        }

        case 'usuarios.save': {
            $db = db();
            $id = (string) ($p['id'] ?? '');
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $u = [
                'id' => $id,
                'lojaId' => $lojaId,
                'usuario' => trim((string) ($p['usuario'] ?? '')),
                'nome' => trim((string) ($p['nome'] ?? '')),
                'funcao' => trim((string) ($p['funcao'] ?? 'vendedor')),
                'senha' => (string) ($p['senha'] ?? ''),
                'ativo' => !empty($p['ativo']),
            ];
            if ($lojaId === '' || $u['usuario'] === '' || $u['nome'] === '' || $u['senha'] === '') {
                fail('DADOS_INCOMPLETOS: loja, usuário, nome e senha são obrigatórios');
            }
            if (!in_array($u['funcao'], FUNCOES(), true)) fail('FUNCAO_INVALIDA');
            if (!findLoja($db, $lojaId)) fail('LOJA_INVALIDA', 404);

            $duplicado = function ($users, $i, $lojaId, $usuario) {
                foreach ($users as $j => $y) {
                    if ($j !== $i && ($y['lojaId'] ?? '') === $lojaId
                        && mb_strtolower($y['usuario'] ?? '') === mb_strtolower($usuario)) {
                        return true;
                    }
                }
                return false;
            };

            foreach ($db['usuarios'] as $i => $x) {
                if (($x['id'] ?? '') === $u['id']) {
                    if ($duplicado($db['usuarios'], $i, $lojaId, $u['usuario'])) fail('USUARIO_DUPLICADO');
                    $db['usuarios'][$i] = $u;
                    saveDb($db);
                    respond(['ok' => true, 'usuario' => userVisible($u, true)]);
                }
            }
            if ($duplicado($db['usuarios'], -1, $lojaId, $u['usuario'])) fail('USUARIO_DUPLICADO');
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