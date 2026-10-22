<?php
// ─────────────────────────────────────────────────────────────
// /natal — página pública do ENVIO DIGITAL.
// O cliente digita o CÓDIGO da venda (6 caracteres) e baixa as fotos
// digitais que comprou. O PDV sobe as fotos por FTP como
// fotos/<CODIGO>_<n>.jpg e, por último, o manifesto fotos/<CODIGO>.json —
// enquanto o manifesto não existe a página mostra "aguarde" (nunca aparece
// venda pela metade). Sem banco, sem cache: lê direto do disco.
// ─────────────────────────────────────────────────────────────
header('Cache-Control: no-store, max-age=0, must-revalidate');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

$FOTOS_DIR = __DIR__ . '/fotos';
$TELEFONE = '(41) 3053-2223';

// Download forçado (no celular o link direto às vezes abre em vez de salvar).
if (isset($_GET['baixar'])) {
    $arq = basename((string) $_GET['baixar']);
    if (preg_match('/^[A-Z0-9]{4,12}_\d+\.jpg$/', $arq) && is_file($FOTOS_DIR . '/' . $arq)) {
        $caminho = $FOTOS_DIR . '/' . $arq;
        header('Content-Description: File Transfer');
        header('Content-Type: image/jpeg');
        header('Content-Disposition: attachment; filename="' . $arq . '"');
        header('Content-Length: ' . filesize($caminho));
        readfile($caminho);
        exit;
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Arquivo nao encontrado';
    exit;
}

$codigo = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) ($_GET['c'] ?? '')));
$codigo = substr($codigo, 0, 12);
$invalido = '';
$fotos = [];
$criadoEm = null;

if ($codigo !== '') {
    if (!preg_match('/^[A-Z0-9]{4,12}$/', $codigo)) {
        $invalido = 'Código inválido — confira e digite de novo.';
    } else {
        $manifesto = $FOTOS_DIR . '/' . $codigo . '.json';
        if (is_file($manifesto)) {
            $dados = json_decode((string) file_get_contents($manifesto), true);
            if (is_array($dados)) {
                $criadoEm = isset($dados['criadoEm']) ? (int) $dados['criadoEm'] : null;
                foreach ((array) ($dados['fotos'] ?? []) as $f) {
                    $arq = basename((string) ($f['arquivo'] ?? ''));
                    if ($arq !== '' && is_file($FOTOS_DIR . '/' . $arq)) {
                        $fotos[] = $arq;
                    }
                }
            }
        }
    }
}

$dataVenda = '';
if ($criadoEm) {
    try {
        $dt = new DateTime('@' . (int) round($criadoEm / 1000));
        $dt->setTimezone(new DateTimeZone('America/Sao_Paulo'));
        $dataVenda = $dt->format('d/m/Y') . ' às ' . $dt->format('H:i');
    } catch (Exception $e) {
        $dataVenda = '';
    }
}
?>
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Suas fotos digitais — Maxx Foto</title>
<style>
  :root{
    --bg1:#0f0c1a; --bg2:#1a1440; --bg3:#2a1f5e;
    --gold:#d4a24c; --gold-l:#ffd166; --cream:#f5efe2;
    --muted:#a9a6c8; --line:rgba(212,162,76,.35);
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{
    min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#f0f0f5;padding:22px 16px 40px;
    background:radial-gradient(1200px 600px at 20% 0%,#3a2a6e 0%,transparent 55%),
               linear-gradient(135deg,var(--bg1) 0%,var(--bg2) 35%,var(--bg3) 70%,var(--bg2) 100%);
  }
  .brand{display:flex;align-items:center;gap:10px;margin:6px 0 26px;letter-spacing:.24em;font-size:12px;font-weight:800;color:var(--gold-l);text-transform:uppercase;}
  .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--gold);box-shadow:0 0 14px var(--gold);}
  .card{
    width:100%;max-width:520px;background:rgba(20,16,48,.72);border:1px solid var(--line);
    border-radius:20px;padding:26px 22px;box-shadow:0 22px 60px rgba(0,0,0,.45);
    backdrop-filter:blur(8px);
  }
  h1{font-size:21px;line-height:1.25;margin-bottom:6px;color:var(--cream);}
  p.sub{font-size:13.5px;color:var(--muted);line-height:1.5;margin-bottom:18px;}
  form{display:flex;flex-direction:column;gap:12px;}
  input[type=text]{
    width:100%;padding:16px 14px;border-radius:12px;border:1px solid var(--line);
    background:#0d0a22;color:var(--gold-l);font-size:28px;font-weight:800;letter-spacing:.28em;
    text-align:center;text-transform:uppercase;font-family:ui-monospace,Consolas,monospace;outline:none;
  }
  input[type=text]:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(212,162,76,.22);}
  button{
    padding:15px;border:0;border-radius:12px;cursor:pointer;font-size:15px;font-weight:800;
    background:linear-gradient(135deg,#f2c66d,#b8842e);color:#1a1030;
  }
  button:active{transform:translateY(1px);}
  .code-tag{
    display:inline-block;font-family:ui-monospace,Consolas,monospace;font-weight:800;
    letter-spacing:.2em;color:var(--gold-l);border:1px dashed var(--line);border-radius:8px;
    padding:3px 10px;font-size:15px;
  }
  .wait{text-align:center;padding:10px 0 2px;}
  .wait .icon{font-size:34px;margin-bottom:10px;}
  .wait h2{font-size:19px;margin-bottom:10px;color:var(--cream);}
  .wait p{font-size:14px;color:var(--muted);line-height:1.6;}
  .phone{margin-top:14px;font-weight:700;color:var(--gold-l);}
  .gallery{display:flex;flex-direction:column;gap:14px;}
  .photo{
    border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#0d0a22;
  }
  .photo img{display:block;width:100%;height:auto;}
  .photo a.dl{
    display:block;text-align:center;padding:13px;font-size:14.5px;font-weight:800;
    color:#1a1030;text-decoration:none;background:linear-gradient(135deg,#f2c66d,#b8842e);
  }
  .meta{font-size:12px;color:var(--muted);text-align:center;margin-top:16px;}
  .err{color:#ff9b9b;font-size:13px;text-align:center;margin-top:4px;}
  .foot{margin-top:26px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.7;}
  .foot a{color:var(--gold-l);text-decoration:none;}
  .back{display:inline-block;margin-top:16px;font-size:12.5px;color:var(--muted);text-decoration:none;}
  .back:hover{color:var(--gold-l);}
</style>
</head>
<body>
  <div class="brand"><span class="dot"></span> Maxx Foto · Natal 2026</div>

  <?php if ($codigo === ''): ?>
    <div class="card">
      <h1>Suas fotos digitais</h1>
      <p class="sub">Digite o código que você recebeu no caixa para ver e baixar as fotos que comprou.</p>
      <form method="get" action="">
        <input type="text" name="c" maxlength="6" autocomplete="off" autocapitalize="characters"
               spellcheck="false" inputmode="text" placeholder="CÓDIGO" autofocus>
        <button type="submit">Ver minhas fotos</button>
      </form>
      <?php if ($invalido !== ''): ?><div class="err"><?= htmlspecialchars($invalido) ?></div><?php endif; ?>
    </div>

  <?php elseif (count($fotos) > 0): ?>
    <div class="card">
      <h1>Suas fotos chegaram!</h1>
      <p class="sub">
        Código <span class="code-tag"><?= htmlspecialchars($codigo) ?></span>
        <?= $dataVenda !== '' ? ' · ' . htmlspecialchars($dataVenda) : '' ?>
      </p>
      <div class="gallery">
        <?php foreach ($fotos as $i => $arq): ?>
          <div class="photo">
            <img src="fotos/<?= htmlspecialchars(rawurlencode($arq)) ?>" alt="Foto digital <?= $i + 1 ?>" loading="lazy">
            <a class="dl" href="?baixar=<?= htmlspecialchars(rawurlencode($arq)) ?>">Baixar foto <?= $i + 1 ?></a>
          </div>
        <?php endforeach; ?>
      </div>
      <div class="meta"><?= count($fotos) ?> foto<?= count($fotos) === 1 ? '' : 's' ?> · toque em "Baixar" para salvar no celular</div>
      <a class="back" href="./">Consultar outro código</a>
    </div>

  <?php else: ?>
    <div class="card wait">
      <div class="icon">⏳</div>
      <h2>Aguarde — logo sua foto chega no nosso servidor</h2>
      <p>
        Código <span class="code-tag"><?= htmlspecialchars($codigo) ?></span><br>
        Assim que o envio terminar, esta página mostra suas fotos automaticamente.
        Atualize a página em alguns instantes.
      </p>
      <p class="phone">Se não aparecer em até 8 horas, fale com a gente:<br><?= htmlspecialchars($TELEFONE) ?></p>
      <a class="back" href="./">Digitar outro código</a>
    </div>
  <?php endif; ?>

  <div class="foot">
    Problemas para baixar? Fale com a equipe Maxx Foto · <?= htmlspecialchars($TELEFONE) ?><br>
    <a href="https://maxxfoto.com.br">maxxfoto.com.br</a>
  </div>
</body>
</html>
