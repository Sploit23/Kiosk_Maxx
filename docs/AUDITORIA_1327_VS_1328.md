# Auditoria 1.3.27 vs 1.3.28

Data: 2026-11-16  
Repositório: `D:\natal\kiosk_foto`  
Escopo: comparar artefatos publicados/locais com a árvore atual antes de qualquer release.

## Fatos verificados

| Item | 1.3.27 (`release-teste`) | 1.3.28 publicado | 1.3.29 extraído | Árvore atual |
|---|---:|---:|---:|---:|
| `package.json` | 1.3.27 | 1.3.28 | 1.3.29 | 1.3.27 (candidato de teste) |
| `resources/natal-core.cjs` | 195.538 / `CA0AD52A4335` | 171.874 / `23F18B913786` | 195.911 / `D4A283F6DCA0` | 204.616 / `C07DE86C061A` |
| `vendas.html` no app | 107.441 / `A249FC158367` | 106.590 | 107.441 | `dist` 107.441 / `BA3C421662D9` |
| Bundle PDV | `pdv-Cb9OtsI_.js` 342.319 | `pdv-DjSTB1uH.js` 319.215 | não extraído | `pdv-Cac5zUEi.js` 342.507 |
| `pay-row-com` no HTML | presente | **ausente** | presente | presente (6 no fonte, 5 no `dist`) |

- Antes do build 1.3.29, `release/win-unpacked/resources/natal-core.cjs` era 204.503 / `5D739D3BC551`, igual à fonte antes do seam `NATAL_IMPORTER_PORT`.
- Antes do build, `release/latest.yml` e `release-teste/latest.yml` declaravam 1.3.27, mas tinham SHA512 diferentes.
- O executável do importador é byte-idêntico em todos os artefatos analisados: 2.455.576 bytes, SHA256 `FABF5922A8DFFB8F066005810C1DC95C4E82638FCCDA0EA91AFB1493A97B6C7C`.
- `HEAD` (`ae12da6`) e `origin/main` (`3a20aa6`) têm `package.json` 1.3.28; o worktree foi atualizado para 1.3.29 nesta sessão.
- O `.28` publicado foi gerado de uma árvore anterior à correção do `pay-row-com` e ao sidecar atual; ele não representa o código que está no worktree.

## Build 1.3.29 gerado localmente

Build executado com `npm run build:win` e `--publish never`; nada foi enviado ao GitHub.

| Artefato | Tamanho | Hash |
|---|---:|---|
| `release/Maxx-Foto-Vendas-Setup-1.3.29.exe` | 135.822.698 | SHA256 `2A465FE60BB23711D861CEDE0009002CB8FBACDCCB1243147026250B1CF6B41B` |
| `release/Maxx-Foto-Vendas-Setup-1.3.29.exe.blockmap` | 138.373 | SHA256 `62221A1811194330F731D7539EBEF6569C5245AA204F0C9E42220F452BCEC28D` |
| `release/latest.yml` | 364 | SHA512 `YCjQjqDkCiH4/Rx01C9PlQ996O+b0kCTQrz3O88hjubJRhrG8whS4G067uHewRXR0Ihg3mI0Xc8h7HWPwaQnhA==` |

- `latest.yml`: versão 1.3.29, mesmo tamanho e SHA512 do instalador.
- `release/win-unpacked/resources/natal-core.cjs`: 204.616 / `C07DE86C061A`, igual ao fonte atual.
- `release/win-unpacked/resources/importador/Natal_Foto_Import.exe`: 2.455.576 / `FABF5922A8DFFB8F066005810C1DC95C4E82638FCCDA0EA91AFB1493A97B6C7C`.
- `release/win-unpacked/resources/web/vendas.html`: 107.441 / `BA3C421662D9`, com 5 ocorrências de `pay-row-com`.
- `release/win-unpacked/resources/web/assets/pdv-Cac5zUEi.js`: 342.507 / `2CE219565459`.
- `test:ci` passou no build: 59 testes OK, 2 skip (sidecar offline); `test:importer` já havia passado com 8/8.

## Conclusão

Antes do build, nenhum artefato existente era uma base canônica confiável. O `.28` publicado é mais antigo que a árvore atual, o `.27` local tem variações entre `release/` e `release-teste/`, e o `.29` extraído antes do build também não correspondia ao sidecar atual.

Decisão de versionamento revista em 2026-11-16: **o candidato de desenvolvimento volta a ser 1.3.27**, sempre instalável/retornável para o **1.3.28** publicado em segundos. O **1.3.29** fica reservado para quando o 1.3.27 estiver comprovadamente funcional e melhor que o 1.3.28. O build 1.3.29 já gerado localmente foi descartado como candidato e não deve ser publicado.

Verificado em 2026-11-16: `gh release list` não tem 1.3.29 e as tags remotas param em `v1.3.28`. Antes de promover qualquer versão:

1. executar o checklist manual de hardware/rede em `docs/CHECKLIST_RELEASE.md`;
2. validar instalação limpa, retorno para a 1.3.28 e desinstalação;
3. manter o 1.3.28 como fallback intocável;
4. só então promover o 1.3.27 funcional para 1.3.29;
5. conferir o SHA256 do instalador e o SHA512 do `latest.yml` no momento do upload.

Não publicar release enquanto o checklist manual e os hashes não forem confirmados.
