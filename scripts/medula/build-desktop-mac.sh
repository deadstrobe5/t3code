#!/usr/bin/env bash
# Build this fork as a locally signed macOS desktop app (arm64 by default)
# that replaces an installed official one in place: same product name, bundle
# id and user-data directory, so threads, settings and the T3 Connect login
# carry over. The version is <upstream>-medula.<UTC timestamp>, and those
# builds ship without an update feed, so no upstream release overwrites them.
#
#   scripts/medula/build-desktop-mac.sh [OUT_DIR]
#
# OUT_DIR defaults to $T3_MEDULA_BUILD_DIR, then ~/.cache/t3code-medula. The
# app lands in OUT_DIR/app/<product>.app; the zip in OUT_DIR/desktop/v<version>.
#
# Environment:
#   T3_MEDULA_ENV               file sourced first (PATH for Node 24 and pnpm).
#   T3_MEDULA_PUBLIC_CONFIG_APP an installed official .app to take the public
#                               T3 Connect config from instead of the
#                               defaults in connect.env (unset: connect.env).
#   T3CODE_MEDULA_DEFAULT_URL   Medula hub address used while the setting is
#                               empty (the desktop page host is not the hub).
#   T3_MEDULA_ARCH              arm64 (default) or x64.
#   T3_MEDULA_SIGN_KEYCHAIN, T3_MEDULA_SIGN_PASSWORD_FILE, T3_MEDULA_SIGN_IDENTITY
#                               local signing identity (missing: ad hoc).
# The last line printed is the path of the .app.
set -euo pipefail
[ -n "${T3_MEDULA_ENV:-}" ] && . "$T3_MEDULA_ENV"
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${1:-${T3_MEDULA_BUILD_DIR:-$HOME/.cache/t3code-medula}}
arch=${T3_MEDULA_ARCH:-arm64}
cd "$repo"
. scripts/medula/connect.env
export PATH="$repo/node_modules/.bin:$PATH"
mkdir -p "$out"
out=$(cd "$out" && pwd)

manifest_version=$(node -p "require('./apps/server/package.json').version" | sed 's/-.*//')
tag_version=$(git tag --merged HEAD --list 'v*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -n 1)
base=$(printf '%s\n' "$manifest_version" "$tag_version" | sed '/^$/d' | sort -V | tail -n 1)
version=${T3_MEDULA_VERSION:-$base-medula.$(date -u +%Y%m%d%H%M)}
echo "== version $version (node $(node -v), pnpm $(pnpm -v))"

manifests=(apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json)
backup=$(mktemp -d)
for f in "${manifests[@]}"; do mkdir -p "$backup/$(dirname "$f")"; cp "$f" "$backup/$f"; done
restore() { for f in "${manifests[@]}"; do cp "$backup/$f" "$f"; done; rm -rf "$backup"; }
trap restore EXIT

echo "== install dependencies"
pnpm install --frozen-lockfile

config_app=${T3_MEDULA_PUBLIC_CONFIG_APP:-}
if [ -n "$config_app" ]; then
  echo "== public T3 Connect config from $config_app"
  config=$(node scripts/medula/public-config-from-app.mjs "$config_app")
  while IFS= read -r line; do export "${line?}"; done <<<"$config"
fi

node scripts/update-release-package-versions.ts "$version"

echo "== build and package ($arch)"
rel="$out/desktop/v$version"
rm -rf "$rel"
node scripts/build-desktop-artifact.ts --platform mac --target zip --arch "$arch" \
  --build-version "$version" --output-dir "$rel"

zip=$(ls "$rel"/*.zip | head -n 1)
rm -rf "$out/app.new"
mkdir -p "$out/app.new"
ditto -x -k "$zip" "$out/app.new"
app=$(ls -d "$out/app.new"/*.app | head -n 1)
# An ad-hoc signature changes with every build, so macOS asks for the
# keychain password on each launch ("t3code Safe Storage"). A local
# self-signed identity keeps the designated requirement stable across builds.
sign_kc=${T3_MEDULA_SIGN_KEYCHAIN:-$HOME/Library/Keychains/t3-assinatura.keychain-db}
sign_pw=${T3_MEDULA_SIGN_PASSWORD_FILE:-$HOME/.config/t3-assinatura/pw}
sign_id=${T3_MEDULA_SIGN_IDENTITY:-9880D9E380FF98772AED94EABD25D240F0F1D97D}
if [ -f "$sign_kc" ] && [ -f "$sign_pw" ]; then
  echo "== signing with the local identity"
  security unlock-keychain -p "$(cat "$sign_pw")" "$sign_kc"
  codesign --force --deep --sign "$sign_id" --keychain "$sign_kc" "$app"
elif ! codesign --verify --deep --strict "$app" 2>/dev/null; then
  echo "== ad-hoc signing"
  codesign --force --deep --sign - "$app"
fi
codesign --verify --deep --strict "$app"
[ ! -e "$app/Contents/Resources/app-update.yml" ] || { echo "app-update.yml present: updater would replace this build" >&2; exit 1; }
rm -rf "$out/app"
mv "$out/app.new" "$out/app"
app="$out/app/$(basename "$app")"
echo "$version" > "$out/latest-desktop-version"
echo "$app"
