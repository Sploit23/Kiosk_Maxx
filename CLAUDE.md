## Continuidade entre PCs (Sploit-Forge)

Este projeto pode ser trabalhado em mais de um PC da malha Sploit-Forge
(ex: Casa, Escritório), por engines diferentes (opencode ou Claude Code).

- No INÍCIO de qualquer sessão: leia `.sploit-handoff.md` (se existir) pra
  saber onde a última sessão parou. Se este projeto for um repositório git
  com remote configurado, dê `git pull` antes de começar.
- No FIM de qualquer sessão (ou de qualquer pedido que mudou algo):
  reescreva `.sploit-handoff.md` com data/hora, o que foi feito, estado
  atual e o próximo passo. Se houve mudança de código e existe remote
  git, comite e dê `git push`.
- Nunca pule esses dois passos -- é assim que a pessoa consegue continuar
  o mesmo projeto de outro PC ou do celular depois.

## Memória da malha (Sploit-Forge)

Além do bilhete deste projeto (.sploit-handoff.md), existe uma memória
COMPARTILHADA entre TODOS os projetos da malha: `MESH_MEMORY.md`, na raiz
do projeto "sploit" (ache o caminho/máquina dele com a ferramenta MCP
list_projects -- pode estar neste PC ou em outro).

- No INÍCIO de um trabalho que pareça não ser específico só deste projeto
  (ex: uma API externa, uma peculiaridade de algum PC/hardware, uma
  convenção de equipe): leia esse `MESH_MEMORY.md` (via read_file, com
  `machine` se o projeto sploit estiver em outro PC) antes de agir.
- Se aprender algo que vale pra qualquer projeto/PC da malha (não só
  este): adicione uma linha curta lá (via edit_file, só acrescentando --
  nunca reescreva o arquivo inteiro nem apague o que já tem).
- Só vale a pena registrar ali o que é genuinamente reaproveitável fora
  deste projeto -- detalhe específico demais fica só no handoff local.
