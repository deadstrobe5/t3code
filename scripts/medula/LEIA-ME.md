# Fork medula do T3 Code

Scripts do ramo `medula`: correr o fork em modo dev ao lado do T3 instalado, fazer o build e instalá-lo.

## Reiniciar sem parar os agentes

O servidor lança cada `claude` atrás de um intermediário (`ADOPTABLE_SHIM` em
`apps/server/src/medula/adoptableSessions.ts`). O `claude` lê de um FIFO e escreve num ficheiro, em
`<base>/userdata/sessoes/<threadId>/<lançamento>/`, e corre na fatia `app-t3code-agents.slice`, fora da unidade do
servidor. Quando o servidor sai, larga as sessões e o `claude` continua. O servidor seguinte, ao abrir a mesma sessão
do Claude para a mesma conversa, liga-se ao `claude` vivo e lê a saída a partir de onde o anterior parou. Os subagentes
são filhos do `claude`, por isso continuam também.

- Uma conversa com a vez cortada retoma pelo mecanismo do upstream, que abre a sessão e adota o `claude`.
- Uma conversa já parada, mas com trabalho em fundo, recebe uma nota de sistema curta
  (`apps/server/src/medula/adoptionReactor.ts`) que abre a sessão.
- Uma sessão que ninguém adotou e que não escreve nada há 6 horas é parada no arranque seguinte.
- Para desligar: `T3_ADOPTABLE_SESSIONS=0` no ambiente do servidor.

Só o Claude com binário nativo é adotável. Codex, ACP (Copilot), OpenCode e terminais continuam a morrer com o servidor.

## Modo dev

Corre o fork noutra porta, com a base em `$T3_DEV_HOME` (nunca a do T3 instalado):

```sh
. /data/scratch/t3code-build/env.sh       # node, pnpm e T3_DEV_HOME=/data/scratch/t3code-dev
scripts/medula/dev.sh start                # servidor em 3780, Vite em 5780 (unidade t3code-dev)
node apps/server/src/bin.ts pair --base-dir "$T3_DEV_HOME"   # link de emparelhamento para o browser
ws-live /data/scratch/t3code-o16           # vigia o servidor (live.toml na raiz)
```

- Se gravares um ficheiro do cliente web (`apps/web`), o Vite atualiza o módulo na página, sem recarregar.
- Se gravares um ficheiro do servidor, o `ws-live` corre `dev.sh reinicia`: o servidor reinicia em ~9 s, a página
  religa sozinha e as conversas continuam.
- Portas ocupadas: `T3_DEV_PORT` e `T3_DEV_WEB_PORT`. Parar: `scripts/medula/dev.sh stop`.

Para usar o Claude no modo dev, põe em `$T3_DEV_HOME/userdata/settings.json` um `providerInstances.claudeAgent` com
`binaryPath` para um executável que carregue o token e faça `exec claude "$@"`. Um script com extensão (`.js`, `.sh`)
não é adotável.

## Build e instalação

```sh
T3_MEDULA_ENV=/data/scratch/t3code-build/env.sh scripts/medula/build.sh /data/scratch/t3code-build
/data/scratch/t3code-build/instala-medula.sh
```

O `install.sh` só reinicia o serviço quando o `T3_MEDULA_IDLE_CHECK` diz que nada se corta. Com as sessões adotáveis,
as conversas do Claude já não se cortam; o que ainda se corta são os outros fornecedores e os terminais.

## Testes

```sh
cd apps/server && node_modules/.bin/vp test run src/medula/
```

O teste de integração lança um `claude` de brincar, larga-o a meio de uma vez como faz o SIGTERM, abre a mesma sessão
num servidor novo e verifica que o resto da vez chega e que não se lançou um segundo `claude`.
