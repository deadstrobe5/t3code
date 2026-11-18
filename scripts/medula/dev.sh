#!/bin/bash
# Fork em modo dev ao lado do T3 instalado: servidor numa porta própria + Vite com HMR.
#
#   scripts/medula/dev.sh start      # arranca (unidade systemd de utilizador; sobrevive a reinícios do T3)
#   scripts/medula/dev.sh reinicia   # reinicia só o servidor: as conversas continuam (sessões adotáveis)
#   scripts/medula/dev.sh stop | status
#
# O browser abre http://127.0.0.1:$T3_DEV_WEB_PORT/ (o Vite encaminha a API e o WebSocket para o servidor).
# Gravar no cliente web: o Vite recarrega o módulo na página. Gravar no servidor: `ws-live t3code` (live.toml na
# raiz) chama `reinicia`; sem ws-live, corre-o à mão.
#
# Configuração (ambiente, ou o ficheiro em T3_MEDULA_ENV):
#   T3_DEV_PORT      porta do servidor (3780)
#   T3_DEV_WEB_PORT  porta do Vite (5780)
#   T3_DEV_HOME      base de dados e sessões do servidor dev ($HOME/.t3-dev), nunca a do T3 instalado
set -euo pipefail
[ -n "${T3_MEDULA_ENV:-}" ] && . "$T3_MEDULA_ENV"
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
PORTA=${T3_DEV_PORT:-3780}
WEB=${T3_DEV_WEB_PORT:-5780}
BASE=${T3_DEV_HOME:-$HOME/.t3-dev}
UNIDADE=t3code-dev
PIDS=$BASE/dev-run
mkdir -p "$PIDS"

corre() {
    # Um servidor dev nunca é o do lançador do T3 instalado (ver scripts/dev-runner.ts).
    unset T3CODE_HOME T3CODE_HOST T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT HOST
    export T3CODE_PORT=$PORTA PORT=$WEB T3CODE_SINGLE_ORIGIN_DEV=1 VITE_DEV_SERVER_URL=http://localhost:$WEB
    (cd "$RAIZ/apps/web" && exec node_modules/.bin/vp dev) &
    echo $! >"$PIDS/web.pid"
    trap 'kill -TERM $(cat "$PIDS/web.pid" "$PIDS/server.pid" 2>/dev/null) 2>/dev/null; exit 0' TERM INT
    # O servidor volta a arrancar sempre que sai; `reinicia` só lhe manda SIGTERM.
    while :; do
        (cd "$RAIZ/apps/server" && exec node src/bin.ts serve --port "$PORTA" --base-dir "$BASE" --no-browser) &
        echo $! >"$PIDS/server.pid"
        wait $! || true
        sleep 1
    done
}

case "${1:-}" in
start)
    if systemctl --user is-active -q "$UNIDADE" 2>/dev/null; then
        echo "já está a correr: http://127.0.0.1:$WEB/"
        exit 0
    fi
    for p in "$PORTA" "$WEB"; do
        if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
            echo "a porta $p já está ocupada; escolhe outra com T3_DEV_PORT / T3_DEV_WEB_PORT" >&2
            exit 1
        fi
    done
    systemd-run --user --unit "$UNIDADE" --collect --quiet \
        --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
        ${T3_MEDULA_ENV:+--setenv=T3_MEDULA_ENV="$T3_MEDULA_ENV"} \
        --setenv=T3_DEV_PORT="$PORTA" --setenv=T3_DEV_WEB_PORT="$WEB" --setenv=T3_DEV_HOME="$BASE" \
        -p StandardOutput=append:"$BASE/dev.log" -p StandardError=append:"$BASE/dev.log" \
        "$0" _corre
    echo "a arrancar: http://127.0.0.1:$WEB/ (servidor em $PORTA, log em $BASE/dev.log)"
    ;;
_corre) corre ;;
reinicia)
    antigo=$(cat "$PIDS/server.pid")
    kill -TERM "$antigo"
    # Um servidor a desligar ainda aceita ligações e já não responde: espera que saia primeiro.
    for _ in $(seq 150); do kill -0 "$antigo" 2>/dev/null || break; sleep 0.2; done
    for _ in $(seq 60); do
        curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$PORTA/" 2>/dev/null && exit 0
        sleep 0.5
    done
    echo "o servidor não voltou em 30 s; ver $BASE/dev.log" >&2
    exit 1
    ;;
stop) systemctl --user stop "$UNIDADE" ;;
status)
    systemctl --user status "$UNIDADE" --no-pager | head -5 || true
    tail -n 5 "$BASE/dev.log" 2>/dev/null || true
    ;;
*)
    sed -n '2,15p' "$0"
    exit 2
    ;;
esac
