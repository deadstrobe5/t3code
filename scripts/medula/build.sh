#!/usr/bin/env bash
# Build this fork as a release that `t3 update` can install: the CLI archive
# (server binary, web client, resource monitor) plus SHA256SUMS, laid out as
# OUT/releases/v<version>/ so install.sh can serve it on loopback and point
# T3CODE_RELEASE_BASE_URL at it. The archive is also unpacked to OUT/dist
# for trying the build by hand.
#
#   scripts/medula/build.sh [OUT_DIR]
#
# OUT_DIR defaults to $T3_MEDULA_BUILD_DIR, then ~/.cache/t3code-medula.
# The version is <upstream version>-medula.<UTC timestamp> (override with
# $T3_MEDULA_VERSION), so every build sorts after the previous one.
# Needs node and pnpm (the versions in package.json) and cargo on PATH; if
# $T3_MEDULA_ENV names a file, it is sourced first to set them up.
# The last line printed is the version.
set -euo pipefail
[ -n "${T3_MEDULA_ENV:-}" ] && . "$T3_MEDULA_ENV"
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${1:-${T3_MEDULA_BUILD_DIR:-$HOME/.cache/t3code-medula}}
cd "$repo"
. scripts/medula/connect.env
mkdir -p "$out"
# Upstream stamps the release version at release time, so the manifest can
# lag behind the newest release tag this commit contains: take the higher.
manifest_version=$(node -p "require('./apps/server/package.json').version" | sed 's/-.*//')
tag_version=$(git tag --merged HEAD --list 'v*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -n 1)
base=$(printf '%s\n' "$manifest_version" "$tag_version" | sed '/^$/d' | sort -V | tail -n 1)
version=${T3_MEDULA_VERSION:-$base-medula.$(date -u +%Y%m%d%H%M)}
echo "== version $version"

# The binary reports the version baked into the package manifests, and
# `t3 update` checks it against the archive name; stamp them for the build
# and put them back afterwards.
manifests=(apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json)
backup=$(mktemp -d)
for f in "${manifests[@]}"; do mkdir -p "$backup/$(dirname "$f")"; cp "$f" "$backup/$f"; done
restore() { for f in "${manifests[@]}"; do cp "$backup/$f" "$f"; done; rm -rf "$backup"; }
trap restore EXIT

echo "== install dependencies"
pnpm install --frozen-lockfile
node scripts/update-release-package-versions.ts "$version"

echo "== build web client and server"
vp run --filter t3 build

echo "== build the single executable"
# Same Node as release CI (SEA_NODE_VERSION in apps/server/vite.config.ts).
VP_NODE_VERSION=${VP_NODE_VERSION:-26.8.2} node apps/server/scripts/cli.ts build-exe

echo "== build the resource monitor"
CARGO_TARGET_DIR="$out/cargo-target" cargo build --locked --release \
  --manifest-path native/resource-monitor/Cargo.toml
rm -rf "$out/resource-monitor"
mkdir -p "$out/resource-monitor/linux-x64"
cp "$out/cargo-target/release/t3-resource-monitor" "$out/resource-monitor/linux-x64/"

echo "== pack the CLI archive"
rel="$out/releases/v$version"
rm -rf "$rel"
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$out/resource-monitor" --output-dir "$rel"
(cd "$rel" && sha256sum -- * > SHA256SUMS)
archive=$(ls "$rel"/*.tar.gz | head -n 1)

echo "== unpack to $out/dist"
rm -rf "$out/dist.new"
mkdir -p "$out/dist.new"
tar -xzf "$archive" -C "$out/dist.new"
inner="$out/dist.new"
if [ ! -x "$inner/t3" ] && [ "$(ls "$inner" | wc -l)" = 1 ]; then inner="$inner/$(ls "$inner")"; fi
[ -x "$inner/t3" ] || { echo "no t3 binary in $archive" >&2; exit 1; }
reported=$("$inner/t3" --version)
case "$reported" in *"v$version") ;; *) echo "the binary says '$reported', expected v$version" >&2; exit 1 ;; esac
rm -rf "$out/dist"
mv "$inner" "$out/dist"
rm -rf "$out/dist.new"
echo "$version" > "$out/latest-version"
echo "$version"
