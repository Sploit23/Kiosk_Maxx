<?php
/**
 * Configuração do Maxx Natal Controller.
 * Não contém segredos de banco — apenas o hash padrão do portal.
 */

declare(strict_types=1);

// Diretório onde os JSON ficam gravados (bloqueado na web por .htaccess).
define('APP_DATA_DIR', __DIR__ . '/data');

// Hash sha256 da senha ADMINISTRADOR do portal (bootstrap do primeiro acesso).
// Padrão: "869407" — troque pelo portal (Gerenciamento → Trocar senha) após o login.
define('ADMIN_SENHA_SHA', 'f6036cba43d24012f135eb0cc73ee36c54a93a78ddacb069885f6235075139fb');