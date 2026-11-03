<?php
/**
 * Maxx Natal Controller — API de cadastro (lojas, vendedores, fotógrafos).
 * Backend single-file para hospedagem compartilhada (PHP 7.4+/8.x).
 * Dados em JSON sob /data (bloqueado na web via .htaccess).
 *
 * Ações públicas : health, login, equipe, kiosk.seed, kiosk.pair, precos,
 *                  vendas.push, pedido.push, auditoria.push
 * Ações admin    : exigem X-Token (header) ou campo "token":
 *   admin.login, lojas.list, lojas.save, lojas.addKiosk, lojas.removeKiosk,
 *   lojas.delete, kiosk.descartar, usuarios.list, usuarios.save,
 *   usuarios.delete, admin.changePassword,
 *   catalogo.get, precos.save, precos.list, vendas.resumo, pedido.list, auditoria.list,
 *   despesas.list, despesas.save, despesas.delete,
 *   estoque.list, estoque.save, parametros.get, parametros.save
 *
 * Pareamento sem copiar código (fluxo principal):
 *   1) o PDV registra `pendentes[kioskCode]` via kiosk.seed com nome do local,
 *      machineName, IP e a loja local (se houver);
 *   2) o admin vê o PC em Lojas → "PDVs aguardando" e clica em Autorizar
 *      (lojas.addKiosk): o pareamento é gravado NA HORA e a máquina entra no
 *      registro permanente `devices[machineId]`;
 *   3) nos próximos polls de kiosk.pair a máquina é reconhecida pelo
 *      machineId — editar a loja ou perder o kioskCode local não desemparelha.
 *      Só lojas.removeKiosk/lojas.delete revogam.
 *
 * Fallback manual: o admin cola o código na loja (Nova loja ou + PDV) e o PDV
 * se autoriza sozinho; lojas.save com código-only cria a loja a partir do
 * rascunho (nome do local) e grava o pareamento na hora.
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

// Conjunto de IDs de lojas cadastradas. Relatórios ignoram registros órfãos:
// quando uma loja é excluída, o histórico dela não some sozinho dos JSONs
// (vendas/pedidos/auditoria/despesas) e não pode continuar aparecendo.
function lojaIdsExistentes(array $db): array
{
    $ids = [];
    foreach (($db['lojas'] ?? []) as $l) {
        $id = (string) ($l['id'] ?? '');
        if ($id !== '') $ids[$id] = true;
    }
    return $ids;
}

function registroDeLojaExistente(array $ids, array $r, bool $manterSemLoja = false): bool
{
    $id = (string) ($r['lojaId'] ?? '');
    if ($id === '') return $manterSemLoja;
    return isset($ids[$id]);
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

function normalizarKioskCode($v): string
{
    return preg_replace('/[^A-Z0-9]/', '', strtoupper(trim((string) $v)));
}

// Códigos de kiosk autorizados numa loja. Uma loja pode ter vários PDVs
// (1 PDV = 1 código): `kioskCodes` guarda a lista; `kioskCode` e os
// `pareamentos[]` entram por compatibilidade com dados antigos.
function lojaKioskCodes(array $loja): array
{
    $codes = [];
    $add = function ($v) use (&$codes) {
        $c = normalizarKioskCode($v);
        if ($c !== '' && !in_array($c, $codes, true)) $codes[] = $c;
    };
    if (isset($loja['kioskCodes']) && is_array($loja['kioskCodes'])) {
        foreach ($loja['kioskCodes'] as $c) $add($c);
    }
    $add($loja['kioskCode'] ?? '');
    foreach ((array) ($loja['pareamentos'] ?? []) as $pm) {
        if (is_array($pm)) $add($pm['kioskCode'] ?? '');
    }
    $add($loja['pareamento']['kioskCode'] ?? '');
    return $codes;
}

// Máquinas pareadas na loja (array novo + legado `pareamento`), sem duplicar.
function lojaPareamentos(array $loja): array
{
    $out = [];
    $ids = [];
    $add = function ($pm) use (&$out, &$ids) {
        if (!is_array($pm)) return;
        $mid = trim((string) ($pm['machineId'] ?? ''));
        if ($mid === '' || isset($ids[$mid])) return;
        $ids[$mid] = true;
        $out[] = $pm;
    };
    foreach ((array) ($loja['pareamentos'] ?? []) as $pm) $add($pm);
    $add($loja['pareamento'] ?? null);
    return $out;
}

// Registro permanente do dispositivo, independente do cadastro da loja.
// `pareamentos` é a lista exibida/editada no portal; este mapa por machineId é
// o que garante que editar a loja (ou perder o código local) não desemparelhe
// a máquina. Só `lojas.removeKiosk`/`lojas.delete` removem a autorização.
function registrarDispositivo(array &$db, string $machineId, array $loja, string $kioskCode, string $pdvNome): void
{
    if ($machineId === '') return;
    if (!isset($db['devices']) || !is_array($db['devices'])) $db['devices'] = [];
    $atual = $db['devices'][$machineId] ?? null;
    $agora = gmdate('c');
    $db['devices'][$machineId] = [
        'machineId' => $machineId,
        'lojaId' => (string) ($loja['id'] ?? ''),
        'lojaNome' => (string) ($loja['nome'] ?? ''),
        'pdvNome' => $pdvNome !== '' ? $pdvNome : (string) ($loja['pdv'] ?? ''),
        'kioskCode' => normalizarKioskCode($kioskCode),
        'criadoEm' => is_array($atual) && !empty($atual['criadoEm']) ? (string) $atual['criadoEm'] : $agora,
        'atualizadoEm' => $agora,
    ];
}

function dispositivoPorMachineId(array $db, string $machineId): ?array
{
    if (!isset($db['devices']) || !is_array($db['devices'])) return null;
    $d = $db['devices'][$machineId] ?? null;
    return is_array($d) ? $d : null;
}

// Um machineId só pode pertencer a UMA loja. O mapa `devices` é a fonte
// permanente de autorização; a checagem por `pareamentos` sozinha deixaria
// passar uma máquina já autorizada noutra loja caso esse array fosse perdido.
function dispositivoDeOutraLoja(array $db, string $machineId, string $lojaId): ?array
{
    $dev = dispositivoPorMachineId($db, $machineId);
    if (!is_array($dev)) return null;
    $devLoja = trim((string) ($dev['lojaId'] ?? ''));
    if ($devLoja === '' || $devLoja === $lojaId) return null;
    if (findLoja($db, $devLoja) === null) return null; // registro órfão de loja excluída
    return $dev;
}

// Grava/atualiza o pareamento de uma máquina dentro da loja (sem derrubar os
// outros PDVs) e garante o código na lista `kioskCodes`.
function aplicarPareamentoLoja(array &$db, string $lojaId, array $pareamento): void
{
    foreach ($db['lojas'] as $i => $x) {
        if (($x['id'] ?? '') !== $lojaId) continue;
        $pms = lojaPareamentos($x);
        $achou = false;
        foreach ($pms as $j => $pm) {
            if ((string) ($pm['machineId'] ?? '') === (string) ($pareamento['machineId'] ?? '')) {
                $pms[$j] = $pareamento;
                $achou = true;
                break;
            }
        }
        if (!$achou) $pms[] = $pareamento;
        if (count($pms) > 20) $pms = array_slice($pms, -20);
        $db['lojas'][$i]['pareamentos'] = $pms;
        $db['lojas'][$i]['pareamento'] = $pareamento; // legado = última máquina
        $code = normalizarKioskCode($pareamento['kioskCode'] ?? '');
        if ($code !== '') {
            $codes = lojaKioskCodes($db['lojas'][$i]);
            if (!in_array($code, $codes, true)) $codes[] = $code;
            $db['lojas'][$i]['kioskCodes'] = $codes;
        }
        break;
    }
}

// Rascunhos enviados pelo kiosk.seed, do mais recente para o mais antigo.
function pendentesLista(array $db): array
{
    $out = [];
    foreach ((array) ($db['pendentes'] ?? []) as $code => $p) {
        if (!is_array($p)) continue;
        $c = normalizarKioskCode($p['kioskCode'] ?? $code);
        if ($c === '') continue;
        $out[] = [
            'kioskCode' => $c,
            'nome' => trim((string) ($p['nome'] ?? '')),
            'pdvNome' => trim((string) ($p['pdvNome'] ?? '')),
            'machineName' => trim((string) ($p['machineName'] ?? '')),
            'lojaId' => trim((string) ($p['lojaId'] ?? '')),
            'lojaNome' => trim((string) ($p['lojaNome'] ?? '')),
            'ip' => trim((string) ($p['ip'] ?? '')),
            'machineId' => trim((string) ($p['machineId'] ?? '')),
            'criadoEm' => (string) ($p['criadoEm'] ?? ''),
            'atualizadoEm' => (string) ($p['atualizadoEm'] ?? ''),
        ];
    }
    usort($out, function ($a, $b) {
        return strcmp((string) ($b['atualizadoEm'] ?? ''), (string) ($a['atualizadoEm'] ?? ''));
    });
    return $out;
}

// Valida que o kiosk que está chamando é a máquina pareada com a loja
// (pedido.push / auditoria.push / vendas.push). Protege contra push de dados
// de fora: só as máquinas físicas daquela loja conseguem mandar.
// Offline-first: a loja é definida NO APP e o portal só AUTORIZA a máquina,
// então a autorização é resolvida pelo machineId — se ele casa com alguma
// loja pareada, essa é a loja canônica do envio (o lojaId do kiosk pode até
// divergir, ex.: loja recriada no portal). Uma loja pode ter vários PDVs.
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
        foreach (lojaPareamentos($l) as $pm) {
            if ((string) ($pm['machineId'] ?? '') === $machineId) { $loja = $l; break 2; }
        }
    }
    // Fallback: registro permanente do dispositivo. Vale mesmo se o pareamento
    // foi removido da loja por edição/corrupção — só a revogação explícita
    // (lojas.removeKiosk/lojas.delete) apaga este mapa.
    if (!$loja) {
        $dev = dispositivoPorMachineId($db, $machineId);
        if (is_array($dev) && !empty($dev['lojaId'])) {
            $porDispositivo = findLoja($db, (string) $dev['lojaId']);
            if ($porDispositivo) $loja = $porDispositivo;
        }
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
    foreach (['vendas.json', 'pedidos.json', 'auditoria.json', 'caixas.json'] as $f) {
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

// Preços efetivos da loja: defaults oficiais + padrão global (__global) +
// ajuste da loja. O catálogo/preços são fixos para todos os PDVs; a loja só
// sobrescreve se quiser mudar algo localmente.
function precosEfetivos(string $lojaId): array
{
    // Catálogo mestre (com lojas por item) é a fonte de verdade: o mapa plano
    // é derivado dele para os PDVs antigos que só conhecem preço por chave.
    if (catalogoMaster() !== null) {
        $cat = catalogoEfetivo($lojaId);
        $out = PRECOS_DEFAULT;
        foreach (['tamanhos' => 'preco', 'extras' => 'preco', 'combos' => 'valorCombo'] as $grupo => $campo) {
            foreach ($cat[$grupo] as $it) {
                if (array_key_exists($it['id'], $out)) {
                    $out[$it['id']] = round((float) $it[$campo], 2);
                }
            }
        }
        return $out;
    }

    $saved = loadJson('precos.json', []);
    $camadas = [];
    if ($lojaId !== '__global' && is_array($saved) && isset($saved['__global']) && is_array($saved['__global'])) {
        $camadas[] = $saved['__global'];
    }
    if (is_array($saved) && isset($saved[$lojaId]) && is_array($saved[$lojaId])) {
        $camadas[] = $saved[$lojaId];
    }
    $out = PRECOS_DEFAULT;
    foreach ($camadas as $overlay) {
        foreach ($overlay as $k => $v) {
            if (array_key_exists($k, $out) && is_numeric($v) && (float) $v >= 0) {
                $out[$k] = round((float) $v, 2);
            }
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
        ['id' => '10x15', 'label' => '10x15', 'preco' => 23.0, 'modelo' => '10x15', 'unidades' => 1],
        ['id' => '15x20', 'label' => '15x20', 'preco' => 28.0, 'modelo' => '15x20', 'unidades' => 2],
        ['id' => 'bolinha', 'label' => 'Bolinha 7,5x7,5', 'preco' => 30.0, 'modelo' => 'bolinha', 'unidades' => 1,
            'nota' => '2 bolinhas iguais por folha 10x15, lado a lado. Sempre vinculada a uma foto 10x15'],
        ['id' => 'polaroide', 'label' => 'Polaroide 2 poses', 'preco' => 28.0, 'modelo' => 'polaroide', 'unidades' => 1,
            'nota' => '2 poses iguais por folha 10x15, lado a lado'],
    ],
    'extras' => [
        ['id' => 'porta-retrato-10x15', 'label' => 'Porta-foto 10x15', 'preco' => 7.0],
        ['id' => 'porta-retrato-15x20', 'label' => 'Porta-foto 15x20', 'preco' => 7.0],
        ['id' => 'porta-retrato-madeira-10x15', 'label' => 'Porta-retrato de madeira preto 10x15', 'preco' => 15.0],
        ['id' => 'porta-retrato-madeira-15x20', 'label' => 'Porta-retrato de madeira preto 15x20', 'preco' => 20.0],
        ['id' => 'ima', 'label' => 'Ímã avulso', 'preco' => 7.0, 'nota' => 'adicional a uma foto 10x15'],
        ['id' => 'foto-digital', 'label' => 'Envio digital (foto)', 'preco' => 25.0, 'digital' => true,
            'nota' => 'a foto escolhida vai para o celular por código'],
        ['id' => 'item-encarte', 'label' => 'Item Encarte', 'preco' => 15.0, 'oculto' => true],
        ['id' => 'porta-cartao-postal', 'label' => 'Cartão Polaroide', 'preco' => 10.0, 'oculto' => true],
    ],
    'combos' => [
        ['id' => 'combo-kit-10x15', 'nome' => 'Foto 10x15 + Porta-foto', 'valorCombo' => 30.0,
            'itens' => [['produtoId' => '10x15', 'qtd' => 1], ['produtoId' => 'porta-retrato-10x15', 'qtd' => 1]]],
        ['id' => 'combo-kit-15x20', 'nome' => 'Foto 15x20 + Porta-foto', 'valorCombo' => 35.0,
            'itens' => [['produtoId' => '15x20', 'qtd' => 1], ['produtoId' => 'porta-retrato-15x20', 'qtd' => 1]]],
        ['id' => 'combo-polaroide-cartao', 'nome' => 'Foto Polaroide + Cartão', 'valorCombo' => 38.0,
            'itens' => [['produtoId' => 'polaroide', 'qtd' => 1], ['produtoId' => 'porta-cartao-postal', 'qtd' => 1]]],
        ['id' => 'combo-encarte-2x15x20', 'nome' => 'Encarte + 2 fotos 15x20', 'valorCombo' => 65.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto1', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
                ['role' => 'foto2', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
            ], 'obrigatorios' => [['tipo' => 'extra', 'produtoId' => 'item-encarte', 'qtd' => 1]]]],
        ['id' => 'combo-encarte-2x15x20-digital', 'nome' => 'Encarte + 2 fotos 15x20 + 2 fotos digitais', 'valorCombo' => 85.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto1', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
                ['role' => 'foto2', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'item-encarte', 'qtd' => 1],
                ['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 2],
            ]]],
        ['id' => 'combo-digital-10x15', 'nome' => 'Foto + Digital 10x15', 'valorCombo' => 40.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['10x15'], 'obrigatorio' => true],
            ], 'obrigatorios' => [['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1]]]],
        ['id' => 'combo-digital-15x20', 'nome' => 'Foto + Digital 15x20', 'valorCombo' => 45.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
            ], 'obrigatorios' => [['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1]]]],
        ['id' => 'combo-10x15-ima-digital', 'nome' => 'Foto 10x15 + Ímã + Digital', 'valorCombo' => 45.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['10x15'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'ima', 'qtd' => 1],
                ['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1],
            ]]],
        ['id' => 'combo-10x15-porta-digital', 'nome' => 'Foto 10x15 + Porta-foto + Digital', 'valorCombo' => 45.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['10x15'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'porta-retrato-10x15', 'qtd' => 1],
                ['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1],
            ]]],
        ['id' => 'combo-15x20-porta-digital', 'nome' => 'Foto 15x20 + Porta-foto + Digital', 'valorCombo' => 50.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['15x20'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'porta-retrato-15x20', 'qtd' => 1],
                ['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1],
            ]]],
        ['id' => 'combo-polaroide-cartao-digital', 'nome' => 'Foto Polaroide + Cartão + Digital', 'valorCombo' => 50.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['polaroide'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'porta-cartao-postal', 'qtd' => 1],
                ['tipo' => 'extra', 'produtoId' => 'foto-digital', 'qtd' => 1],
            ]]],
        ['id' => 'combo-bolinha-1', 'nome' => 'Bolinha + 1 foto 10x15', 'valorCombo' => 30.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['10x15'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'bolinha', 'qtd' => 1],
            ]]],
        ['id' => 'combo-bolinha-2', 'nome' => '2 Bolinhas + 1 foto 10x15', 'valorCombo' => 50.0, 'modo' => 'slots',
            'regras' => ['slots' => [
                ['role' => 'foto', 'tipo' => 'tamanho', 'modelos' => ['10x15'], 'obrigatorio' => true],
            ], 'obrigatorios' => [
                ['tipo' => 'extra', 'produtoId' => 'bolinha', 'qtd' => 2],
            ]]],
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

// Lojas em que um item do catálogo aparece. Lista vazia = todas as lojas
// (inclusive as criadas depois), que é o padrão do catálogo atual.
function catLojas($v): array
{
    if (!is_array($v)) return [];
    $out = [];
    foreach ($v as $id) {
        $id = trim((string) $id);
        // IDs de loja reais podem ter espaços/acentos (ex.: "Mogi Guaçu");
        // só rejeita vazio, longo demais ou caractere de controle.
        if ($id === '' || mb_strlen($id, 'UTF-8') > 64) continue;
        if (preg_match('/[\x00-\x1F\x7F]/', $id)) continue;
        if (!in_array($id, $out, true)) $out[] = $id;
        if (count($out) >= 100) break;
    }
    return $out;
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
        $lojas = catLojas($it['lojas'] ?? []);
        if ($lojas) $row['lojas'] = $lojas;
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
        $lojas = catLojas($it['lojas'] ?? []);
        if ($lojas) $row['lojas'] = $lojas;
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
        $modo = ($it['modo'] ?? '') === 'slots' ? 'slots' : null;
        $regras = null;
        if ($modo === 'slots' && is_array($it['regras'])) {
            $slotsIn = (array) ($it['regras']['slots'] ?? []);
            $slots = [];
            foreach ($slotsIn as $s) {
                if (!is_array($s)) continue;
                $role = catId($s['role'] ?? '');
                if ($role === '') $role = 'foto';
                $tiposSlot = ($s['tipo'] ?? '') === 'extra' ? 'extra' : 'tamanho';
                $modelos = [];
                foreach ((array) ($s['modelos'] ?? []) as $m) {
                    $mm = catId($m);
                    if (in_array($mm, ['10x15','15x20','bolinha','polaroide'], true)) $modelos[] = $mm;
                }
                if (!$modelos && $tiposSlot === 'tamanho') $modelos = ['10x15'];
                $slots[] = [
                    'role' => $role,
                    'tipo' => $tiposSlot,
                    'modelos' => $modelos,
                    'obrigatorio' => !empty($s['obrigatorio']),
                    'vinculado' => !empty($s['vinculado']),
                ];
            }
            $obrig = [];
            foreach ((array) ($it['regras']['obrigatorios'] ?? []) as $o) {
                if (!is_array($o)) continue;
                $pid = catId($o['produtoId'] ?? '');
                if ($pid === '' || !isset($tipos[$pid])) continue;
                $q = (int) ($o['qtd'] ?? 1);
                if ($q < 1) $q = 1;
                if ($q > 99) $q = 99;
                $obrig[] = ['tipo' => $tipos[$pid], 'produtoId' => $pid, 'qtd' => $q];
            }
            if ($slots) {
                $regras = ['slots' => $slots];
                if ($obrig) $regras['obrigatorios'] = $obrig;
            }
        }
        $itens = [];
        if (!$regras) {
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
        }
        $row = [
            'id' => $id,
            'nome' => catTexto($it['nome'] ?? $id) ?: $id,
            'valorCombo' => catPreco($it['valorCombo'] ?? 0),
        ];
        if ($regras) {
            $row['modo'] = 'slots';
            $row['regras'] = $regras;
        } elseif ($itens) {
            $row['itens'] = $itens;
        }
        if (!empty($it['inline'])) $row['inline'] = true;
        if (!empty($it['encarte'])) $row['encarte'] = true;
        $alvo = catId($it['tamanhoAlvo'] ?? '');
        if ($alvo !== '') $row['tamanhoAlvo'] = $alvo;
        $lojas = catLojas($it['lojas'] ?? []);
        if ($lojas) $row['lojas'] = $lojas;
        $combos[] = $row;
        $tipos[$id] = 'combo';
    }

    return ['tamanhos' => $tamanhos, 'extras' => $extras, 'combos' => $combos];
}

// Catálogo mestre: uma única lista com `lojas` por item (vazio = todas). É o
// modelo novo do admin, onde cada produto/combo escolhe em quais PDVs aparece.
function catalogoMaster(): ?array
{
    $saved = loadJson('precos.json', []);
    if (!is_array($saved) || !isset($saved['__catalogo'])) return null;
    return sanitizarCatalogo($saved['__catalogo']);
}

function itemVisivelLoja(array $item, string $lojaId): bool
{
    if ($lojaId === '' || $lojaId === '__global') return true;
    $lojas = (array) ($item['lojas'] ?? []);
    if (!$lojas) return true; // sem restrição = todas as lojas
    return in_array($lojaId, $lojas, true);
}

// Recorta o catálogo mestre para uma loja: itens com `lojas` só aparecem nas
// lojas marcadas; 10x15/15x20 são sempre mantidos (base da impressão). Combos
// que dependem de um item escondido naquela loja também ficam de fora para o
// PDV não receber um combo quebrado.
function filtrarCatalogoPorLoja(array $cat, string $lojaId): array
{
    $obrigatorios = ['10x15' => true, '15x20' => true];
    $tamanhos = [];
    foreach ((array) $cat['tamanhos'] as $it) {
        if (isset($obrigatorios[$it['id']]) || itemVisivelLoja($it, $lojaId)) $tamanhos[] = $it;
    }
    $extras = [];
    foreach ((array) $cat['extras'] as $it) {
        if (itemVisivelLoja($it, $lojaId)) $extras[] = $it;
    }
    $visiveis = [];
    foreach (array_merge($tamanhos, $extras) as $it) $visiveis[$it['id']] = true;

    $combos = [];
    foreach ((array) $cat['combos'] as $it) {
        if (!itemVisivelLoja($it, $lojaId)) continue;
        $ok = true;
        foreach ((array) ($it['itens'] ?? []) as $ci) {
            if (!isset($visiveis[$ci['produtoId'] ?? ''])) { $ok = false; break; }
        }
        if ($ok && !empty($it['regras']['obrigatorios'])) {
            foreach ((array) $it['regras']['obrigatorios'] as $o) {
                if (!isset($visiveis[$o['produtoId'] ?? ''])) { $ok = false; break; }
            }
        }
        if ($ok) $combos[] = $it;
    }
    return ['tamanhos' => $tamanhos, 'extras' => $extras, 'combos' => $combos];
}

// Catálogo efetivo da loja: o mestre recortado por loja (quando existe) ou o
// salvo antigo/defaults com o overlay de preços aplicado — garante que a tela
// do admin e o PDV mostrem sempre a mesma lista.
function catalogoEfetivo(string $lojaId): array
{
    $master = catalogoMaster();
    if ($master !== null) return filtrarCatalogoPorLoja($master, $lojaId);

    $saved = loadJson('precos.json', []);
    $global = (is_array($saved) && isset($saved['__global']) && is_array($saved['__global'])) ? $saved['__global'] : [];
    $overlay = (is_array($saved) && $lojaId !== '__global' && isset($saved[$lojaId]) && is_array($saved[$lojaId])) ? $saved[$lojaId] : [];

    // Catálogo da loja > catálogo padrão global > default do código.
    if (isset($overlay['__catalogo'])) {
        $cat = sanitizarCatalogo($overlay['__catalogo']);
        if ($cat !== null) return $cat;
    }
    if (isset($global['__catalogo'])) {
        $cat = sanitizarCatalogo($global['__catalogo']);
        if ($cat !== null) return $cat;
    }
    $cat = CATALOGO_DEFAULT;
    $camadas = ($lojaId === '__global') ? [$global] : [$global, $overlay];
    foreach ($camadas as $ov) {
        foreach (['tamanhos' => 'preco', 'extras' => 'preco', 'combos' => 'valorCombo'] as $grupo => $campo) {
            foreach ($cat[$grupo] as $i => $it) {
                if (isset($ov[$it['id']]) && is_numeric($ov[$it['id']]) && (float) $ov[$it['id']] >= 0) {
                    $cat[$grupo][$i][$campo] = round((float) $ov[$it['id']], 2);
                }
            }
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

// Modelo físico de impressão de um item. 15x20 é o único que consome 2
// unidades de ribbon; bolinha e polaroide saem no molde 10x15 (1 unidade).
function modeloImpressaoItemPortal($produtoId, $modelo = ''): string
{
    $m = strtolower(trim((string) $modelo));
    if ($m === '15x20') return '15x20';
    if ($m !== '') return '10x15';
    $pid = strtolower(trim((string) $produtoId));
    return strpos($pid, '15x20') !== false ? '15x20' : '10x15';
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
        // senão o kiosk.pair casaria antes de o admin confirmar). O admin vê
        // os rascunhos em Lojas → "PDVs aguardando" e autoriza em 1 clique,
        // sem copiar código. O código fica como fallback manual.
        case 'kiosk.seed': {
            $db = db();
            $kioskCode = normalizarKioskCode($p['kioskCode'] ?? '');
            $nome = trim((string) ($p['nome'] ?? ''));
            $pdvNome = trim((string) ($p['pdvNome'] ?? ''));
            $machineId = trim((string) ($p['machineId'] ?? ''));
            $machineName = trim((string) ($p['machineName'] ?? ''));
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $lojaNome = trim((string) ($p['lojaNome'] ?? ''));
            $ip = trim((string) ($p['ip'] ?? ''));
            if ($kioskCode === '' || $nome === '') fail('DADOS_INCOMPLETOS: kioskCode e nome são obrigatórios', 400);
            if (mb_strlen($nome, 'UTF-8') > 80) fail('NOME_INVALIDO', 400);
            if (mb_strlen($machineName, 'UTF-8') > 80) $machineName = mb_substr($machineName, 0, 80, 'UTF-8');
            if (mb_strlen($lojaNome, 'UTF-8') > 80) $lojaNome = mb_substr($lojaNome, 0, 80, 'UTF-8');

            // Já existe loja com este código? Então nada a fazer (pareamento
            // segue pelo kiosk.pair normal) — responde ok para o PDV parar.
            // Confere a lista inteira (`kioskCodes`), não só o código principal.
            $existe = false;
            foreach ($db['lojas'] as $l) {
                if (in_array($kioskCode, lojaKioskCodes($l), true)) { $existe = true; break; }
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
                'machineName' => $machineName,
                'lojaId' => $lojaId,
                'lojaNome' => $lojaNome,
                'ip' => $ip,
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
            if ($machineId === '') fail('DADOS_INCOMPLETOS: machineId é obrigatório', 400);

            // Autorização permanente por machineId: se a máquina já foi
            // autorizada uma vez, ela NÃO depende mais do código local nem da
            // lista `pareamentos` da loja (editar a loja não desemparelha).
            $device = dispositivoPorMachineId($db, $machineId);
            if (is_array($device) && !empty($device['lojaId'])) {
                $lojaDev = findLoja($db, (string) $device['lojaId']);
                if ($lojaDev) {
                    if (empty($lojaDev['ativo'])) fail('LOJA_INVALIDA', 404);
                    if ($kioskCode === '') $kioskCode = normalizarKioskCode($device['kioskCode'] ?? '');
                    $pareamento = [
                        'pdvNome' => resolverPdvNome($pdvNome !== '' ? $pdvNome : (string) ($device['pdvNome'] ?? ''), $lojaDev),
                        'machineId' => $machineId,
                        'kioskCode' => $kioskCode !== '' ? $kioskCode : normalizarKioskCode($lojaDev['kioskCode'] ?? ''),
                        'emparelhadoEm' => gmdate('c'),
                    ];
                    aplicarPareamentoLoja($db, (string) $lojaDev['id'], $pareamento);
                    registrarDispositivo($db, $machineId, $lojaDev, (string) $pareamento['kioskCode'], (string) $pareamento['pdvNome']);
                    saveDb($db);
                    respond([
                        'ok' => true,
                        'loja' => ['id' => $lojaDev['id'], 'nome' => $lojaDev['nome'], 'pdv' => $lojaDev['pdv'], 'kioskCode' => $kioskCode],
                        'pareamento' => $pareamento,
                    ]);
                }
            }

            // Fluxo principal: o kiosk envia o CÓDIGO que aparece na tela dele.
            // A loja pode ter VÁRIOS códigos (um por PDV); o admin autoriza em
            // 1 clique (Lojas → PDVs aguardando) ou, no fallback, digita o
            // código na loja e cada máquina se autoriza sozinha.
            $loja = null;
            if ($kioskCode !== '') {
                foreach ($db['lojas'] as $l) {
                    if (in_array($kioskCode, lojaKioskCodes($l), true)) { $loja = $l; break; }
                }
                if (!$loja) fail('KIOSK_NAO_EMPARELELHADO', 404); // admin ainda não autorizou este código numa loja
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

            // Bloqueia a mesma máquina já emparelhada noutra loja (imagem clonada).
            foreach ($db['lojas'] as $l) {
                if (($l['id'] ?? '') === $loja['id']) continue;
                foreach (lojaPareamentos($l) as $pm) {
                    if ($machineId !== '' && hash_equals((string) ($pm['machineId'] ?? ''), $machineId)) {
                        fail('MAQUINA_JA_EMPARELHADA', 409);
                    }
                }
            }
            if (dispositivoDeOutraLoja($db, $machineId, (string) $loja['id']) !== null) {
                fail('MAQUINA_JA_EMPARELHADA', 409);
            }

            $pareamento = [
                'pdvNome' => resolverPdvNome($pdvNome, $loja),
                'machineId' => $machineId,
                'kioskCode' => $kioskCode !== '' ? $kioskCode : normalizarKioskCode($loja['kioskCode'] ?? ''),
                'emparelhadoEm' => gmdate('c'),
            ];
            aplicarPareamentoLoja($db, (string) $loja['id'], $pareamento);
            registrarDispositivo($db, $machineId, $loja, (string) $pareamento['kioskCode'], (string) $pareamento['pdvNome']);
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
                'pdvNome' => resolverPdvNome($p['pdvNome'] ?? '', $loja),
                'machineId' => trim((string) ($p['machineId'] ?? '')),
                'data' => $data,
                'totalVendido' => $totalVendido,
                'pedidos' => max(0, (int) ($p['pedidos'] ?? 0)),
                'sessoesCriadas' => max(0, (int) ($p['sessoesCriadas'] ?? 0)),
                'sessoesVendidas' => max(0, (int) ($p['sessoesVendidas'] ?? 0)),
                'taxacombo' => round(min(100, max(0, (float) ($p['taxacombo'] ?? 0))), 1),
                'descontos' => round(max(0, (float) ($p['descontos'] ?? 0)), 2),
                'descontoPedidos' => max(0, (int) ($p['descontoPedidos'] ?? 0)),
                'fotos10x15' => max(0, (int) ($p['fotos10x15'] ?? 0)),
                'fotos15x20' => max(0, (int) ($p['fotos15x20'] ?? 0)),
                'unidadesRibbon' => max(0, (int) ($p['unidadesRibbon'] ?? 0)),
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
            // Uma linha por máquina: a loja pode ter vários PDVs e cada um
            // mantém o próprio snapshot (os relatórios somam por loja).
            $found = null;
            $legado = null;
            foreach ($vendas as $i => $v) {
                if (($v['lojaId'] ?? '') !== $lojaId || ($v['data'] ?? '') !== $data) continue;
                $vm = trim((string) ($v['machineId'] ?? ''));
                if ($vm !== '' && $vm === $snap['machineId']) { $found = $i; break; }
                if ($vm === '' && $legado === null) $legado = $i;
            }
            if ($found === null && $legado !== null) $found = $legado; // adota snapshot antigo sem machineId
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
            $fotos10x15 = 0;
            $fotos15x20 = 0;
            $unidadesRibbon = 0;
            foreach ((array) ($pd['itens'] ?? []) as $it) {
                if (!is_array($it)) continue;
                $tipo = trim((string) ($it['tipo'] ?? 'tamanho'));
                $produtoId = trim((string) ($it['produtoId'] ?? ''));
                $qtd = max(0, (int) ($it['qtd'] ?? 1));
                $modelo = $tipo === 'tamanho' ? modeloImpressaoItemPortal($produtoId, $it['modelo'] ?? '') : '';
                $unidades = max(0, (int) ($it['unidades'] ?? 0));
                if ($tipo === 'tamanho') {
                    if ($unidades <= 0) $unidades = ($modelo === '15x20' ? 2 : 1) * $qtd;
                    if ($modelo === '15x20') $fotos15x20 += $qtd; else $fotos10x15 += $qtd;
                    $unidadesRibbon += $unidades;
                }
                $itens[] = [
                    'tipo' => $tipo,
                    'produtoId' => $produtoId,
                    'label' => trim((string) ($it['label'] ?? '')),
                    'qtd' => $qtd,
                    'unidades' => $unidades,
                    'modelo' => $modelo,
                    // preço/subtotal podem ser negativos (desconto de combo, ajustes)
                    'precoUnit' => round((float) ($it['precoUnit'] ?? 0), 2),
                    'subtotal' => round((float) ($it['subtotal'] ?? 0), 2),
                ];
            }
            $descontoItens = [];
            foreach ((array) ($pd['descontoItens'] ?? []) as $di) {
                if (!is_array($di)) continue;
                $valorDi = round(abs((float) ($di['valor'] ?? 0)), 2);
                if ($valorDi <= 0.004) continue;
                $descontoItens[] = [
                    'tipo' => trim((string) ($di['tipo'] ?? 'ajuste')),
                    'label' => trim((string) ($di['label'] ?? 'Desconto')),
                    'valor' => $valorDi,
                ];
            }
            // Compatibilidade com PDVs antigos: só mandavam o valor numérico.
            // Garante que TODO desconto chegue detalhado ao portal.
            $descontoValor = round(max(0, (float) ($pd['desconto'] ?? 0)), 2);
            if (!$descontoItens && $descontoValor > 0.004) {
                $descontoItens[] = ['tipo' => 'desconto', 'label' => 'Desconto', 'valor' => $descontoValor];
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
                'unidadesTotal' => $unidadesRibbon,
                'fotos10x15' => $fotos10x15,
                'fotos15x20' => $fotos15x20,
                'unidadesRibbon' => $unidadesRibbon,
                'itens' => $itens,
                'pagamentos' => $pagamentos,
                'sessoes' => is_array($pd['sessoes'] ?? null) ? array_values($pd['sessoes']) : [],
                'desconto' => $descontoValor,
                'descontoItens' => $descontoItens,
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

        // Caixa (PDV → portal), idempotente pelo id CX-*. A abertura cria o
        // registro (operador/fundo) e o fechamento atualiza o MESMO id com a
        // conciliação (quem fechou, meios, diferença, envelope).
        case 'caixa.push': {
            [$db, $loja] = validarLojaPareada($p);
            $c = $p['caixa'] ?? null;
            if (!is_array($c)) fail('DADOS_INCOMPLETOS: caixa é obrigatório');
            $id = trim((string) ($c['id'] ?? ''));
            if ($id === '') fail('DADOS_INCOMPLETOS: caixa.id é obrigatório');

            $numMap = function ($arr): array {
                $out = [];
                if (!is_array($arr)) return $out;
                foreach ($arr as $k => $v) {
                    if (!is_scalar($v)) continue;
                    $out[trim((string) $k)] = round((float) $v, 2);
                }
                return $out;
            };
            $fechadoEm = trim((string) ($c['fechadoEm'] ?? ''));
            $registro = [
                'id' => $id,
                'numero' => (string) ($c['numero'] ?? ''),
                'lojaId' => $loja['id'],
                'lojaNome' => lojaNomePush($p, $loja),
                'pdvNome' => resolverPdvNome($c['pdvNome'] ?? '', $loja),
                'machineId' => trim((string) ($p['machineId'] ?? '')),
                'status' => $fechadoEm !== '' ? 'fechado' : 'aberto',
                'data' => trim((string) ($c['data'] ?? substr((string) ($c['abertoEm'] ?? ''), 0, 10))),
                'operador' => trim((string) ($c['operador'] ?? '')),
                'abertoEm' => trim((string) ($c['abertoEm'] ?? '')),
                'valorInicial' => round((float) ($c['valorInicial'] ?? 0), 2),
                'fechadoEm' => $fechadoEm,
                'fechadoPor' => trim((string) ($c['fechadoPor'] ?? '')),
                'totalVendido' => round((float) ($c['totalVendido'] ?? 0), 2),
                'totalPorMeio' => $numMap($c['totalPorMeio'] ?? []),
                'meiosDeclarados' => $numMap($c['meiosDeclarados'] ?? []),
                'totalRecebido' => round((float) ($c['totalRecebido'] ?? 0), 2),
                'diferenca' => round((float) ($c['diferenca'] ?? 0), 2),
                'valorEnvelope' => round((float) ($c['valorEnvelope'] ?? 0), 2),
                'saldoRestante' => round((float) ($c['saldoRestante'] ?? 0), 2),
                'observacoes' => trim((string) ($c['observacoes'] ?? '')),
                'enviadoEm' => gmdate('c'),
            ];

            $caixas = loadJson('caixas.json', []);
            if (!is_array($caixas)) $caixas = [];
            $found = null;
            foreach ($caixas as $i => $r) {
                if (($r['id'] ?? '') === $id) { $found = $i; break; }
            }
            if ($found !== null) $caixas[$found] = $registro; else $caixas[] = $registro;
            saveJson('caixas.json', $caixas);
            respond(['ok' => true, 'caixa' => $registro]);
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
            $db = db();
            $lojas = $db['lojas'];
            $cx = conexaoPorLoja();
            foreach ($lojas as &$l) {
                $id = (string) ($l['id'] ?? '');
                $c = $cx[$id] ?? ['ultimaConexao' => '', 'conexaoDelta' => null, 'online' => false];
                $l['ultimaConexao'] = $c['ultimaConexao'];
                $l['conexaoDelta'] = $c['conexaoDelta'];
                $l['online'] = $c['online'];
            }
            unset($l);
            respond([
                'ok' => true,
                'lojas' => array_values($lojas),
                'pendentes' => pendentesLista($db),
            ]);
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
                // Código já autorizado noutra loja (rascunho velho): autorizar
                // aqui criaria uma segunda loja com o mesmo código e o PDV
                // poderia parear na loja errada.
                foreach ($db['lojas'] as $l) {
                    if (in_array($kioskCode, lojaKioskCodes($l), true)) {
                        fail('CODIGO_EM_USO — este código do kiosk já está em outra loja', 409);
                    }
                }
                $pend = $db['pendentes'][$kioskCode] ?? null;
                if (!is_array($pend) || empty($pend['nome'])) {
                    usleep(250000);
                    fail('RASCUNHO_NAO_ENCONTRADO: nenhum PDV registrou este código — cadastre a loja manualmente', 404);
                }
                $nome = trim((string) $pend['nome']);
                // Modo "vincular a uma loja existente": o rascunho só tem o
                // nome do PC, não o nome do local — não cria uma loja "PDV X";
                // o admin deve autorizar numa loja existente (addKiosk).
                if (empty($pend['lojaNome']) && preg_match('/^PDV\s/i', $nome)) {
                    fail('RASCUNHO_SEM_LOJA: este PDV não informou o nome do local — autorize numa loja existente', 400);
                }
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
                    'kioskCodes' => [$kioskCode],
                    'pareamentos' => [],
                    'ativo' => true,
                ];
                $machineId = trim((string) ($pend['machineId'] ?? ''));
                if ($machineId !== '') {
                    // Mesma trava de clone do kiosk.pair: uma máquina só numa loja.
                    foreach ($db['lojas'] as $l) {
                        if (($l['id'] ?? '') === $id) continue;
                        foreach (lojaPareamentos($l) as $pm) {
                            if (hash_equals((string) ($pm['machineId'] ?? ''), $machineId)) {
                                fail('MAQUINA_JA_EMPARELHADA', 409);
                            }
                        }
                    }
                    if (dispositivoDeOutraLoja($db, $machineId, $id) !== null) {
                        fail('MAQUINA_JA_EMPARELHADA', 409);
                    }
                    $pm = [
                        'pdvNome' => $pdv,
                        'machineId' => $machineId,
                        'kioskCode' => $kioskCode,
                        'emparelhadoEm' => gmdate('c'),
                    ];
                    $loja['pareamentos'][] = $pm;
                    $loja['pareamento'] = $pm;
                }
                $db['lojas'][] = $loja;
                if ($machineId !== '') {
                    registrarDispositivo($db, $machineId, $loja, $kioskCode, (string) $pdv);
                }
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

            // Códigos do kiosk (um por PDV). A edição ADICIONA códigos — para
            // remover um PDV use `lojas.removeKiosk`. Cadastro pode ficar vazio
            // (preencher depois que o kiosk exibir o código).
            $codes = $anterior ? lojaKioskCodes($anterior['loja']) : [];
            $novosCodes = [];
            $addCode = function ($v) use (&$codes, &$novosCodes) {
                $c = normalizarKioskCode($v);
                if ($c === '') return;
                if (!in_array($c, $codes, true)) { $codes[] = $c; $novosCodes[] = $c; }
            };
            if (isset($p['kioskCodes']) && is_array($p['kioskCodes'])) {
                foreach ($p['kioskCodes'] as $c) $addCode($c);
            }
            $addCode($kioskCode);

            $kioskCodePrincipal = $anterior ? normalizarKioskCode($anterior['loja']['kioskCode'] ?? '') : '';
            if ($kioskCodePrincipal === '' || !in_array($kioskCodePrincipal, $codes, true)) {
                $kioskCodePrincipal = $codes[0] ?? '';
            }

            // Não deixa duas lojas usarem o mesmo código (de emparelhamento ou de kiosk).
            foreach ($db['lojas'] as $j => $l) {
                if ($anterior && $j === $anterior['i']) continue;
                $outro = (string) ($l['pairingCode'] ?? '');
                if ($outro !== '' && $pairingCode !== '' && hash_equals($outro, $pairingCode)) {
                    fail('CODIGO_EM_USO', 409);
                }
                foreach ($codes as $c) {
                    if (in_array($c, lojaKioskCodes($l), true)) {
                        fail('CODIGO_EM_USO — este código do kiosk já está em outra loja', 409);
                    }
                }
            }

            $loja = [
                'id' => $id,
                'nome' => $nome,
                'pdv' => $pdv,
                'pairingCode' => $pairingCode,
                'kioskCode' => $kioskCodePrincipal,
                'kioskCodes' => $codes,
                'ativo' => !empty($p['ativo']),
            ];
            if ($anterior) {
                if (isset($anterior['loja']['pareamento'])) $loja['pareamento'] = $anterior['loja']['pareamento'];
                if (isset($anterior['loja']['pareamentos'])) $loja['pareamentos'] = $anterior['loja']['pareamentos'];
                $db['lojas'][$anterior['i']] = $loja;
            } else {
                $db['lojas'][] = $loja;
            }
            // Cadastro/adição de código consistente com o wizard → consome o
            // rascunho do PDV (senão sobra em `pendentes` pra sempre).
            foreach ($novosCodes as $c) {
                if (isset($db['pendentes'][$c])) unset($db['pendentes'][$c]);
            }
            saveDb($db);
            respond(['ok' => true, 'loja' => $loja]);
        }

        // Adiciona um PDV (código) à loja existente. Se houver rascunho do
        // kiosk.seed, autoriza a máquina NA HORA (pareamento + registro
        // permanente) sem esperar o poll de 30s. Não substitui os códigos já
        // cadastrados.
        case 'lojas.addKiosk': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            $code = normalizarKioskCode($p['kioskCode'] ?? '');
            if ($id === '' || $code === '') fail('DADOS_INCOMPLETOS: id e kioskCode são obrigatórios');
            $idx = null;
            foreach ($db['lojas'] as $i => $l) {
                if (($l['id'] ?? '') === $id) { $idx = $i; break; }
            }
            if ($idx === null) fail('LOJA_NAO_ENCONTRADA', 404);
            $loja = $db['lojas'][$idx];
            $codes = lojaKioskCodes($loja);
            $jaExistia = in_array($code, $codes, true);
            if (!$jaExistia) {
                foreach ($db['lojas'] as $j => $l) {
                    if ($j === $idx) continue;
                    if (in_array($code, lojaKioskCodes($l), true)) {
                        fail('CODIGO_EM_USO — este código do kiosk já está em outra loja', 409);
                    }
                }
                $codes[] = $code;
                $db['lojas'][$idx]['kioskCodes'] = $codes;
                if (normalizarKioskCode($db['lojas'][$idx]['kioskCode'] ?? '') === '') {
                    $db['lojas'][$idx]['kioskCode'] = $code;
                }
            }

            $pend = $db['pendentes'][$code] ?? null;
            $machineId = is_array($pend) ? trim((string) ($pend['machineId'] ?? '')) : '';
            $pareado = false;
            if ($machineId !== '') {
                // Mesma trava de clone do kiosk.pair: uma máquina só numa loja.
                foreach ($db['lojas'] as $j => $l) {
                    if ($j === $idx) continue;
                    foreach (lojaPareamentos($l) as $pm) {
                        if (hash_equals((string) ($pm['machineId'] ?? ''), $machineId)) {
                            fail('MAQUINA_JA_EMPARELHADA', 409);
                        }
                    }
                }
                if (dispositivoDeOutraLoja($db, $machineId, $id) !== null) {
                    fail('MAQUINA_JA_EMPARELHADA', 409);
                }
                $pdvNome = is_array($pend) ? trim((string) ($pend['pdvNome'] ?? '')) : '';
                $pareamento = [
                    'pdvNome' => resolverPdvNome($pdvNome, $loja),
                    'machineId' => $machineId,
                    'kioskCode' => $code,
                    'emparelhadoEm' => gmdate('c'),
                ];
                aplicarPareamentoLoja($db, $id, $pareamento);
                registrarDispositivo($db, $machineId, $db['lojas'][$idx], $code, (string) $pareamento['pdvNome']);
                $pareado = true;
            }
            if (isset($db['pendentes'][$code])) unset($db['pendentes'][$code]);
            saveDb($db);
            respond(['ok' => true, 'jaExistia' => $jaExistia, 'pareado' => $pareado, 'loja' => $db['lojas'][$idx]]);
        }

        // Remove um rascunho de PDV que nunca foi autorizado.
        case 'kiosk.descartar': {
            $db = db();
            $code = normalizarKioskCode($p['kioskCode'] ?? '');
            if ($code === '') fail('DADOS_INCOMPLETOS: kioskCode é obrigatório');
            if (!isset($db['pendentes'][$code])) {
                respond(['ok' => true, 'removido' => false]);
            }
            unset($db['pendentes'][$code]);
            saveDb($db);
            respond(['ok' => true, 'removido' => true]);
        }

        // Remove um PDV da loja: apaga o código e o pareamento daquela máquina.
        // O PDV perde a autorização e para de enviar (volta a tentar pair).
        case 'lojas.removeKiosk': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            $code = normalizarKioskCode($p['kioskCode'] ?? '');
            if ($id === '' || $code === '') fail('DADOS_INCOMPLETOS: id e kioskCode são obrigatórios');
            $idx = null;
            foreach ($db['lojas'] as $i => $l) {
                if (($l['id'] ?? '') === $id) { $idx = $i; break; }
            }
            if ($idx === null) fail('LOJA_NAO_ENCONTRADA', 404);
            $loja = $db['lojas'][$idx];
            $codes = lojaKioskCodes($loja);
            if (!in_array($code, $codes, true)) {
                respond(['ok' => true, 'removido' => false, 'loja' => $loja]);
            }
            $codes = array_values(array_filter($codes, function ($c) use ($code) { return $c !== $code; }));

            $legado = normalizarKioskCode($loja['kioskCode'] ?? '');
            $pms = [];
            $maquinasRemovidas = [];
            foreach (lojaPareamentos($loja) as $pm) {
                $pmCode = normalizarKioskCode($pm['kioskCode'] ?? '');
                if ($pmCode !== '') {
                    if (in_array($pmCode, $codes, true)) $pms[] = $pm;
                    else {
                        $mid = trim((string) ($pm['machineId'] ?? ''));
                        if ($mid !== '') $maquinasRemovidas[$mid] = true;
                    }
                    continue;
                }
                // Pareamento antigo sem código: só remove se era o único código.
                if ($legado === $code && count($codes) === 0) {
                    $mid = trim((string) ($pm['machineId'] ?? ''));
                    if ($mid !== '') $maquinasRemovidas[$mid] = true;
                    continue;
                }
                $pms[] = $pm;
            }

            $db['lojas'][$idx]['kioskCodes'] = $codes;
            $db['lojas'][$idx]['kioskCode'] = $codes[0] ?? '';
            $db['lojas'][$idx]['pareamentos'] = $pms;
            if ($pms) $db['lojas'][$idx]['pareamento'] = $pms[count($pms) - 1];
            else unset($db['lojas'][$idx]['pareamento']);

            // Revogação explícita: remove também o registro permanente desta
            // máquina/código (não adianta manter autorização órfã no devices).
            if (isset($db['devices']) && is_array($db['devices'])) {
                foreach ($db['devices'] as $mid => $dev) {
                    if (normalizarKioskCode($dev['kioskCode'] ?? '') === $code || isset($maquinasRemovidas[$mid])) {
                        unset($db['devices'][$mid]);
                    }
                }
            }
            saveDb($db);
            respond(['ok' => true, 'removido' => true, 'loja' => $db['lojas'][$idx]]);
        }

        case 'lojas.delete': {
            $db = db();
            $id = trim((string) ($p['id'] ?? ''));
            if ($id === '') fail('DADOS_INCOMPLETOS: id é obrigatório');
            $lojaExcluida = findLoja($db, $id);
            $before = count($db['lojas']);
            $db['lojas'] = array_values(array_filter($db['lojas'], function ($l) use ($id) {
                return ($l['id'] ?? '') !== $id;
            }));
            if (count($db['lojas']) === $before) fail('LOJA_NAO_ENCONTRADA', 404);

            // Operadores: remove a loja do vínculo; quem só existia nela é apagado.
            $usuariosRemovidos = 0;
            $usuarios = [];
            foreach (($db['usuarios'] ?? []) as $u) {
                $lojas = $u['lojas'] ?? (($u['lojaId'] ?? '') !== '' ? [(string) $u['lojaId']] : []);
                $restantes = [];
                foreach ($lojas as $l) if ((string) $l !== $id) $restantes[] = (string) $l;
                if (count($restantes) === 0) { $usuariosRemovidos++; continue; }
                if (count($restantes) !== count($lojas)) {
                    $u['lojas'] = $restantes;
                    if ((string) ($u['lojaId'] ?? '') === $id) $u['lojaId'] = $restantes[0];
                }
                $usuarios[] = $u;
            }
            $db['usuarios'] = $usuarios;
            if (isset($db['devices']) && is_array($db['devices'])) {
                foreach ($db['devices'] as $mid => $dev) {
                    if ((string) ($dev['lojaId'] ?? '') === $id) unset($db['devices'][$mid]);
                }
            }
            // Rascunhos que apontavam para a loja excluída não devem continuar
            // em "PDVs aguardando" (o código pode até ter sido cadastrado nela).
            if (is_array($lojaExcluida) && isset($db['pendentes']) && is_array($db['pendentes'])) {
                $codesExcluidos = lojaKioskCodes($lojaExcluida);
                foreach ($db['pendentes'] as $code => $pend) {
                    $codeNorm = normalizarKioskCode($code);
                    if (in_array($codeNorm, $codesExcluidos, true)
                        || (string) ($pend['lojaId'] ?? '') === $id) {
                        unset($db['pendentes'][$code]);
                    }
                }
            }
            saveDb($db);

            // Histórico da loja excluída: apaga dos arquivos dos relatórios.
            $removidos = ['usuarios' => $usuariosRemovidos, 'vendas' => 0, 'pedidos' => 0, 'auditoria' => 0, 'despesas' => 0, 'caixas' => 0];
            $arquivos = [
                'vendas.json' => 'vendas',
                'pedidos.json' => 'pedidos',
                'auditoria.json' => 'auditoria',
                'despesas.json' => 'despesas',
                'caixas.json' => 'caixas',
            ];
            foreach ($arquivos as $arquivo => $chave) {
                $linhas = loadJson($arquivo, null);
                if (!is_array($linhas)) continue;
                $filtradas = [];
                foreach ($linhas as $r) {
                    if ((string) ($r['lojaId'] ?? '') === $id) { $removidos[$chave]++; continue; }
                    $filtradas[] = $r;
                }
                if (count($filtradas) !== count($linhas)) saveJson($arquivo, $filtradas);
            }
            // Catálogo/preços NÃO são apagados: são fixos para todos os PDVs
            // (o ajuste por loja é opcional e o padrão global continua valendo).
            respond(['ok' => true, 'removidos' => $removidos]);
        }

        // Manutenção: apaga registros órfãos de lojas excluídas ANTES da limpeza
        // em cascata existir. Idempotente e não toca nas lojas cadastradas.
        case 'lojas.limparOrfaos': {
            $db = db();
            $ids = lojaIdsExistentes($db);
            if (count($ids) === 0) fail('SEM_LOJAS: cadastre uma loja antes de limpar os dados');
            $removidos = ['usuarios' => 0, 'vendas' => 0, 'pedidos' => 0, 'auditoria' => 0, 'despesas' => 0, 'caixas' => 0];

            $mudouUsuarios = false;
            $usuarios = [];
            foreach (($db['usuarios'] ?? []) as $u) {
                $lojas = $u['lojas'] ?? (($u['lojaId'] ?? '') !== '' ? [(string) $u['lojaId']] : []);
                $existentes = [];
                foreach ($lojas as $l) if (isset($ids[(string) $l])) $existentes[] = (string) $l;
                if (count($existentes) === 0) { $removidos['usuarios']++; $mudouUsuarios = true; continue; }
                if (count($existentes) !== count($lojas)) { $u['lojas'] = $existentes; $mudouUsuarios = true; }
                if (!isset($ids[(string) ($u['lojaId'] ?? '')])) { $u['lojaId'] = $existentes[0]; $mudouUsuarios = true; }
                $usuarios[] = $u;
            }
            if ($mudouUsuarios) { $db['usuarios'] = $usuarios; saveDb($db); }

            $arquivos = [
                'vendas.json' => 'vendas',
                'pedidos.json' => 'pedidos',
                'auditoria.json' => 'auditoria',
                'despesas.json' => 'despesas',
                'caixas.json' => 'caixas',
            ];
            foreach ($arquivos as $arquivo => $chave) {
                $linhas = loadJson($arquivo, null);
                if (!is_array($linhas)) continue;
                $filtradas = [];
                foreach ($linhas as $r) {
                    if (!registroDeLojaExistente($ids, $r, $arquivo === 'despesas.json')) {
                        $removidos[$chave]++;
                        continue;
                    }
                    $filtradas[] = $r;
                }
                if (count($filtradas) !== count($linhas)) saveJson($arquivo, $filtradas);
            }
            // Catálogo/preços ficam intactos (padrão global + ajustes por loja).
            respond(['ok' => true, 'removidos' => $removidos]);
        }

        // Catálogo mestre do admin (itens com `lojas`). Se ainda não existe,
        // devolve o catálogo efetivo global para migrar sem perder o que já
        // estava publicado.
        case 'catalogo.get': {
            $master = catalogoMaster();
            if ($master === null) $master = catalogoEfetivo('__global');
            respond(['ok' => true, 'master' => true, 'catalogo' => $master]);
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
            if ($lojaId === '__master') {
                // Modelo novo: uma única lista; cada item traz `lojas` (vazio =
                // todas). O PDV recebe o recorte da sua loja em `precos`.
                if ($catalogo === null) {
                    fail('CATALOGO_INVALIDO: informe pelo menos os tamanhos 10x15 e 15x20 e combos com itens válidos');
                }
                $dados = loadJson('precos.json', []);
                if (!is_array($dados)) $dados = [];
                unset($dados['__master']); // limpa sobra de deploy antigo
                $dados['__catalogo'] = $catalogo;
                saveJson('precos.json', $dados);
                respond(['ok' => true, 'master' => true, 'precos' => precosEfetivos('__global'), 'catalogo' => $catalogo]);
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
            $ids = lojaIdsExistentes(db());
            $todas = array_values(array_filter($todas, function ($r) use ($ids) {
                return registroDeLojaExistente($ids, $r);
            }));
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
            $ids = lojaIdsExistentes(db());
            $out = [];
            foreach ($todos as $r) {
                if (!registroDeLojaExistente($ids, $r)) continue;
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

        // Caixas de todas as lojas (abertura + fechamento) — Fluxo de Caixa.
        case 'caixa.list': {
            $todos = loadJson('caixas.json', []);
            if (!is_array($todos)) $todos = [];
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $dataIni = trim((string) ($p['dataIni'] ?? ''));
            $dataFim = trim((string) ($p['dataFim'] ?? ''));
            $ids = lojaIdsExistentes(db());
            $out = [];
            foreach ($todos as $r) {
                if (!registroDeLojaExistente($ids, $r)) continue;
                if ($lojaId !== '' && ($r['lojaId'] ?? '') !== $lojaId) continue;
                $data = (string) ($r['data'] ?? '');
                if ($data === '') $data = substr((string) ($r['abertoEm'] ?? ''), 0, 10);
                if ($dataIni !== '' && $data < $dataIni) continue;
                if ($dataFim !== '' && $data > $dataFim) continue;
                $out[] = $r;
            }
            usort($out, function ($a, $b) {
                return strcmp((string) ($b['abertoEm'] ?? ''), (string) ($a['abertoEm'] ?? '')) ?: 0;
            });
            respond(['ok' => true, 'caixas' => array_values($out), 'total' => count($out)]);
        }

        // Usos de senha master de todas as lojas — tela "Auditoria".
        case 'auditoria.list': {
            $todos = loadJson('auditoria.json', []);
            if (!is_array($todos)) $todos = [];
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $dataIni = trim((string) ($p['dataIni'] ?? ''));
            $dataFim = trim((string) ($p['dataFim'] ?? ''));
            $ids = lojaIdsExistentes(db());
            $out = [];
            foreach ($todos as $r) {
                if (!registroDeLojaExistente($ids, $r)) continue;
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

        // Estoque de produtos por loja. A quantidade é a contagem física
        // informada pela gestão; as vendas pagas desde `contadoEm` são
        // descontadas automaticamente dos pedidos consolidados.
        case 'estoque.list': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $ids = lojaIdsExistentes(db());
            if ($lojaId === '' || !isset($ids[$lojaId])) fail('LOJA_INVALIDA');

            $cat = catalogoEfetivo($lojaId);
            $estoque = loadJson('estoque.json', []);
            if (!is_array($estoque)) $estoque = [];
            $atual = (isset($estoque[$lojaId]) && is_array($estoque[$lojaId])) ? $estoque[$lojaId] : [];

            $vendas = [];
            $pedidos = loadJson('pedidos.json', []);
            if (!is_array($pedidos)) $pedidos = [];
            foreach ($pedidos as $pedido) {
                if (!is_array($pedido) || ($pedido['lojaId'] ?? '') !== $lojaId) continue;
                $status = strtolower(trim((string) ($pedido['status'] ?? '')));
                if (!in_array($status, ['pago', 'impresso'], true)) continue;
                $quando = strtotime((string) ($pedido['pagoEm'] ?? '')) ?: strtotime((string) ($pedido['criadoEm'] ?? ''));
                if (!$quando) continue;
                foreach ((array) ($pedido['itens'] ?? []) as $item) {
                    if (!is_array($item)) continue;
                    $tipo = trim((string) ($item['tipo'] ?? ''));
                    if (!in_array($tipo, ['tamanho', 'extra'], true)) continue;
                    $produtoId = trim((string) ($item['produtoId'] ?? ''));
                    $qtd = max(0, (int) ($item['qtd'] ?? 0));
                    if ($produtoId === '' || $qtd <= 0) continue;
                    $vendas[] = ['produtoId' => $produtoId, 'qtd' => $qtd, 'ts' => $quando];
                }
            }

            $saida = [];
            foreach (['tamanhos' => 'Tamanhos', 'extras' => 'Extras'] as $grupo => $grupoLabel) {
                foreach ((array) ($cat[$grupo] ?? []) as $produto) {
                    if (!is_array($produto) || !empty($produto['digital'])) continue;
                    $produtoId = trim((string) ($produto['id'] ?? ''));
                    if ($produtoId === '') continue;
                    $registro = (isset($atual[$produtoId]) && is_array($atual[$produtoId])) ? $atual[$produtoId] : null;
                    $quantidade = $registro !== null ? (int) ($registro['quantidade'] ?? 0) : 0;
                    $contadoEm = $registro !== null ? (string) ($registro['contadoEm'] ?? '') : '';
                    $limite = $contadoEm !== '' ? strtotime($contadoEm) : false;
                    $vendidos = 0;
                    if ($limite) {
                        foreach ($vendas as $venda) {
                            if ($venda['produtoId'] === $produtoId && $venda['ts'] >= $limite) $vendidos += $venda['qtd'];
                        }
                    }
                    $saida[] = [
                        'produtoId' => $produtoId,
                        'label' => trim((string) ($produto['label'] ?? $produtoId)),
                        'grupo' => $grupoLabel,
                        'preco' => round((float) ($produto['preco'] ?? 0), 2),
                        'quantidade' => $quantidade,
                        'contadoEm' => $contadoEm,
                        'vendidos' => $vendidos,
                        'saldo' => $quantidade - $vendidos,
                        'configurado' => $contadoEm !== '',
                    ];
                }
            }
            respond(['ok' => true, 'lojaId' => $lojaId, 'itens' => $saida]);
        }

        case 'estoque.save': {
            $lojaId = trim((string) ($p['lojaId'] ?? ''));
            $ids = lojaIdsExistentes(db());
            if ($lojaId === '' || !isset($ids[$lojaId])) fail('LOJA_INVALIDA');
            $itens = $p['itens'] ?? null;
            if (!is_array($itens)) fail('DADOS_INCOMPLETOS: itens é obrigatório');

            $cat = catalogoEfetivo($lojaId);
            $permitidos = [];
            foreach (['tamanhos', 'extras'] as $grupo) {
                foreach ((array) ($cat[$grupo] ?? []) as $produto) {
                    if (!is_array($produto) || !empty($produto['digital'])) continue;
                    $produtoId = trim((string) ($produto['id'] ?? ''));
                    if ($produtoId !== '') $permitidos[$produtoId] = true;
                }
            }

            $estoque = loadJson('estoque.json', []);
            if (!is_array($estoque)) $estoque = [];
            if (!isset($estoque[$lojaId]) || !is_array($estoque[$lojaId])) $estoque[$lojaId] = [];
            $atual = $estoque[$lojaId];
            $agora = gmdate('c');
            $salvos = 0;
            foreach ($itens as $item) {
                if (!is_array($item)) continue;
                $produtoId = trim((string) ($item['produtoId'] ?? ''));
                if ($produtoId === '' || !isset($permitidos[$produtoId])) continue;
                $quantidade = max(0, (int) ($item['quantidade'] ?? 0));
                $anterior = (isset($atual[$produtoId]) && is_array($atual[$produtoId])) ? $atual[$produtoId] : null;
                $qtdAnterior = $anterior !== null ? (int) ($anterior['quantidade'] ?? 0) : null;
                $mudou = $anterior === null || $qtdAnterior !== $quantidade;
                if ($anterior === null && $quantidade <= 0) continue;
                $registro = $anterior !== null ? $anterior : [];
                $registro['quantidade'] = $quantidade;
                if ($mudou || empty($registro['contadoEm'])) $registro['contadoEm'] = $agora;
                $registro['atualizadoEm'] = $agora;
                $estoque[$lojaId][$produtoId] = $registro;
                $salvos++;
            }
            if (!saveJson('estoque.json', $estoque)) fail('FALHA_AO_SALVAR', 500);
            respond(['ok' => true, 'salvos' => $salvos]);
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
            $ids = lojaIdsExistentes(db());
            $todas = array_values(array_filter($todas, function ($r) use ($ids) {
                return registroDeLojaExistente($ids, $r, true); // lojaId vazio = despesa geral
            }));
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
            $ids = lojaIdsExistentes($db);
            $lojaId = (string) ($p['lojaId'] ?? '');
            $users = [];
            foreach (($db['usuarios'] ?? []) as $u) {
                $lojas = $u['lojas'] ?? (($u['lojaId'] ?? '') !== '' ? [(string) $u['lojaId']] : []);
                $existentes = [];
                foreach ($lojas as $l) if (isset($ids[(string) $l])) $existentes[] = (string) $l;
                if (count($existentes) === 0) continue; // operador órfão de loja excluída
                if (count($existentes) !== count($lojas)) $u['lojas'] = $existentes;
                if (!isset($ids[(string) ($u['lojaId'] ?? '')])) $u['lojaId'] = $existentes[0];
                $users[] = userVisible($u, true);
            }
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