#!/usr/bin/env bash
# Install a build made by build.sh through `t3 update`, so the service gets
# the same switch an official release gets: the runtime unpacked under
# <T3 home>/runtime/versions/<version>, the launcher and the service unit
# repointed, and a trial start with a database backup and rollback.
#
#   scripts/medula/install.sh [--no-restart] [BUILD_DIR [VERSION]]
#
# BUILD_DIR defaults to $T3_MEDULA_BUILD_DIR, then ~/.cache/t3code-medula;
# VERSION defaults to the last one built there.
#
# Restarting the service cuts every turn in progress, so the restart only
# happens when $T3_MEDULA_IDLE_CHECK (a command that exits 0 when nothing
# would be cut, and prints why not otherwise) says so. Without such a command
# the restart is skipped. --no-restart installs and repoints without
# restarting; the next service restart picks the new version up.
set -euo pipefail
restart=1
if [ "${1:-}" = "--no-restart" ]; then restart=0; shift; fi
out=${1:-${T3_MEDULA_BUILD_DIR:-$HOME/.cache/t3code-medula}}
version=${2:-$(cat "$out/latest-version")}
t3=${T3_MEDULA_T3:-$HOME/.local/bin/t3}
rel="$out/releases/v$version"
[ -f "$rel/SHA256SUMS" ] || { echo "no release for $version in $out/releases" >&2; exit 1; }
[ -x "$t3" ] || { echo "no t3 launcher at $t3" >&2; exit 1; }

if [ "$restart" = 1 ]; then
  check=${T3_MEDULA_IDLE_CHECK:-}
  if [ -z "$check" ]; then
    echo "no T3_MEDULA_IDLE_CHECK set: installing without restarting" >&2
    restart=0
  elif ! why=$($check); then
    echo "not installing $version now, T3 is busy: ${why//$'\n'/ }"
    exit 75
  fi
fi

# Serve the release directory on loopback for the length of the update.
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$out/releases" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/v$version/SHA256SUMS" && break
  python3 -c 'import time; time.sleep(0.1)'
done

args=(update "$version" --allow-downgrade)
if [ "$restart" = 1 ]; then args+=(--yes); fi
# Without a terminal and without --yes, `t3 update` installs and repoints but
# leaves the running service alone.
T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$port" "$t3" "${args[@]}" </dev/null
