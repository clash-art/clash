#!/bin/sh
# Installs the self-contained Clash CLI/daemon (bundled Node, ffmpeg, ffprobe).
#
#   curl -fsSL <release>/install.sh | sh
#   sh install.sh --uninstall
#
# The archive is accepted only if its SHA-256 matches the release's SHA256SUMS.
# Environment:
#   CLASH_RELEASE_BASE_URL  directory holding SHA256SUMS and the archives
#   CLASH_INSTALL_DIR       versions root   (default: ~/.local/share/clash)
#   CLASH_BIN_DIR           launcher link   (default: ~/.local/bin)
set -eu

base_url=${CLASH_RELEASE_BASE_URL:-https://github.com/clash-art/clash/releases/download/cli-preview}
install_dir=${CLASH_INSTALL_DIR:-$HOME/.local/share/clash}
bin_dir=${CLASH_BIN_DIR:-$HOME/.local/bin}

fail() {
  echo "clash install: $*" >&2
  exit 1
}

if [ "${1:-}" = "--uninstall" ]; then
  # Project data lives under CLASH_HOME and is deliberately left alone.
  if [ -h "$bin_dir/clash" ]; then rm -f "$bin_dir/clash"; fi
  rm -rf "$install_dir/versions" "$install_dir/current"
  rmdir "$install_dir" 2>/dev/null || true
  echo "Removed Clash from $install_dir"
  exit 0
fi
[ $# -eq 0 ] || fail "unknown argument: $1"

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  fail "the bundled Node needs glibc; musl systems such as Alpine are not supported"
fi
target=$os-$arch

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

fetch "$base_url/SHA256SUMS" "$work/SHA256SUMS" || fail "cannot download $base_url/SHA256SUMS"
entry=$(grep -E "^[0-9a-f]{64}  clash-[0-9A-Za-z.+-]+-$target\.tgz\$" "$work/SHA256SUMS" | head -n 1) || true
[ -n "$entry" ] || fail "this release has no archive for $target"
expected=${entry%% *}
archive=${entry##* }
name=${archive%.tgz}

if [ ! -x "$install_dir/versions/$name/bin/clash" ]; then
  echo "Downloading $archive"
  fetch "$base_url/$archive" "$work/$archive" || fail "cannot download $base_url/$archive"
  actual=$(sha256_of "$work/$archive")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"
  mkdir -p "$install_dir/versions" "$work/unpacked"
  tar -xzf "$work/$archive" -C "$work/unpacked"
  [ -x "$work/unpacked/package/bin/clash" ] || fail "$archive is not a self-contained Clash archive"
  rm -rf "$install_dir/versions/$name"
  mv "$work/unpacked/package" "$install_dir/versions/$name"
fi

# Switch the active version; the previous one stays on disk for a rollback.
rm -f "$install_dir/current"
ln -s "versions/$name" "$install_dir/current"
mkdir -p "$bin_dir"
rm -f "$bin_dir/clash"
ln -s "$install_dir/current/bin/clash" "$bin_dir/clash"

echo "Installed $name: $("$bin_dir/clash" --version)"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to run 'clash'." ;;
esac
