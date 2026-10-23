#!/usr/bin/env bash
# From this Linux machine, build the fork's desktop app on the Mac and install
# it over the official "T3 Code (Beta).app": Node 24 and pnpm under ~/.local
# on the Mac (no sudo, nothing on the system PATH), this checkout's HEAD
# pushed over ssh to the Mac clone at ~/code/t3code (GitHub is only used for
# the first clone, so nothing has to be pushed there), build-desktop-mac.sh,
# a backup of the official app, quit, copy, open, version check.
#
#   scripts/medula/instala-mac.sh [--no-build] [--no-open]
#
# Environment:
#   T3_MAC_HOST     ssh target (default afonso@mac)
#   T3CODE_MEDULA_DEFAULT_URL  hub address baked in (default http://afonso-linux:8801)
# Long: run it under ws-detach.
set -euo pipefail
host=${T3_MAC_HOST:-afonso@mac}
hub=${T3CODE_MEDULA_DEFAULT_URL:-http://afonso-linux:8801}
build=1 open=1
for a in "$@"; do
  case $a in
    --no-build) build=0 ;;
    --no-open) open=0 ;;
    *) echo "unknown argument $a" >&2; exit 2 ;;
  esac
done
repo=$(cd "$(dirname "$0")/../.." && pwd)
remote=$(git -C "$repo" remote get-url origin)
[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] ||
  echo "warning: uncommitted changes are not built, only HEAD $(git -C "$repo" rev-parse --short HEAD)" >&2

ssh "$host" "[ -d code/t3code/.git ] || git clone -q '$remote' code/t3code"
git -C "$repo" push -q --force "$host:code/t3code" HEAD:refs/heads/instala-mac

ssh "$host" HUB="$hub" BUILD="$build" OPEN="$open" bash -s <<'MAC'
set -euo pipefail
B=$HOME/code/t3code-build
R=$HOME/code/t3code
APP="/Applications/T3 Code (Beta).app"
mkdir -p "$B" "$HOME/.local"

echo "== toolchain"
if [ ! -x "$HOME/.local/node/bin/node" ]; then
  v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")))')
  curl -fsSL "https://nodejs.org/dist/$v/node-$v-darwin-arm64.tar.gz" -o "$B/node.tar.gz"
  rm -rf "$HOME/.local/node.new" && mkdir -p "$HOME/.local/node.new"
  tar -xzf "$B/node.tar.gz" -C "$HOME/.local/node.new" --strip-components 1
  rm -rf "$HOME/.local/node" && mv "$HOME/.local/node.new" "$HOME/.local/node" && rm "$B/node.tar.gz"
fi
cat >"$B/env.sh" <<ENV
export PATH=\$HOME/.local/node/bin:\$HOME/.local/pnpm/bin:\$PATH
export PNPM_HOME=\$HOME/.local/pnpm-home
export pnpm_config_store_dir=\$HOME/code/t3code-build/pnpm-store
ENV
. "$B/env.sh"
want=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$R/package.json" 2>/dev/null || true)
if [ -z "$want" ] || [ "$(pnpm -v 2>/dev/null)" != "$want" ]; then
  npm install -g --prefix "$HOME/.local/pnpm" "pnpm@${want:-latest}" >/dev/null
fi

echo "== source"
git -C "$R" fetch -q --tags origin || true
git -C "$R" checkout -q --detach instala-mac
git -C "$R" log --oneline -1
want=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$R/package.json")
[ "$(pnpm -v)" = "$want" ] || npm install -g --prefix "$HOME/.local/pnpm" "pnpm@$want" >/dev/null
echo "node $(node -v), pnpm $(pnpm -v)"

if [ "$BUILD" = 1 ]; then
  echo "== build"
  # pnpm wants a TTY to purge node_modules made with another store; do it here.
  if [ -d "$R/node_modules" ] && ! grep -qs "$B/pnpm-store" "$R/node_modules/.modules.yaml"; then
    echo "removing node_modules from another store"
    find "$R" -name node_modules -type d -prune -exec rm -rf {} +
  fi
  # The official app is the source of the public T3 Connect config.
  cfg="$APP"
  [ -d "$B/oficial/T3 Code (Beta).app" ] && cfg="$B/oficial/T3 Code (Beta).app"
  T3_MEDULA_ENV="$B/env.sh" T3_MEDULA_PUBLIC_CONFIG_APP="$cfg" T3CODE_MEDULA_DEFAULT_URL="$HUB" \
    "$R/scripts/medula/build-desktop-mac.sh" "$B"
fi
new=$(ls -d "$B"/app/*.app | head -n 1)
version=$(cat "$B/latest-desktop-version")

echo "== install $version"
cur=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)
if [ -d "$APP" ] && [[ "$cur" != *-medula.* ]] && [ ! -d "$B/oficial/T3 Code (Beta).app" ]; then
  mkdir -p "$B/oficial"
  ditto "$APP" "$B/oficial/T3 Code (Beta).app"
  echo "official $cur backed up to $B/oficial"
fi
if pgrep -xq "T3 Code (Beta)"; then
  osascript -e 'quit app "T3 Code (Beta)"' || true
  for _ in $(seq 1 20); do pgrep -xq "T3 Code (Beta)" || break; sleep 1; done
  pkill -x "T3 Code (Beta)" || true
fi
rm -rf "$APP.new"
ditto "$new" "$APP.new"
rm -rf "$APP"
mv "$APP.new" "$APP"
installed=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)
echo "installed $installed"
[[ "$installed" == *-medula.* ]]
[ "$OPEN" = 1 ] && open -a "$APP"
echo "ok"
MAC
