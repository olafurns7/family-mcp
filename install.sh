#!/bin/sh
# Install a verified release. Only the optional WARP setup needs administrator access.
set -eu
version=${INFOMENTOR_VERSION:-0.5.0}
prefix=${INFOMENTOR_PREFIX:-${HOME:?HOME must be set}/.local}
network=''
case "$*" in '') ;; --with-warp) network=warp ;; --without-warp) network=direct ;; *) echo 'Usage: install.sh [--with-warp|--without-warp]' >&2; exit 1 ;; esac
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo 'Invalid INFOMENTOR_VERSION.' >&2; exit 1 ;; esac
case "$prefix" in /*) ;; *) echo 'INFOMENTOR_PREFIX must be an absolute path.' >&2; exit 1 ;; esac
case $(uname -s) in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Use the npm package on this operating system.' >&2; exit 1 ;; esac
case $(uname -m) in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
[ -n "$network" ] || network=$(cat "$prefix/share/infomentor-mcp/network" 2>/dev/null || printf direct)
case "$network" in direct|warp) ;; *) echo 'Invalid saved network setting.' >&2; exit 1 ;; esac
if [ "$network" = warp ] && { [ "$platform" != linux ] || [ "$arch" != x64 ]; }; then echo 'Automatic WARP setup supports Debian 13 on x64.' >&2; exit 1; fi
for tool in curl tar mktemp; do command -v "$tool" >/dev/null || { echo "Required command missing: $tool" >&2; exit 1; }; done
if command -v sha256sum >/dev/null; then checksum=sha256sum
elif command -v shasum >/dev/null; then checksum=shasum
else echo 'sha256sum or shasum is required.' >&2; exit 1
fi
archive="infomentor-mcp-$version-$platform-$arch.tar.gz"
url="https://github.com/olafurns7/infomentor-mcp/releases/download/v$version/$archive"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/infomentor-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$url" -o "$temporary/$archive"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$url.sha256" -o "$temporary/checksum"
read -r full_digest checked_file < "$temporary/checksum"
[ "$checked_file" = "$archive" ] && [ "${#full_digest}" -eq 64 ] || { echo 'Invalid checksum file.' >&2; exit 1; }
case "$full_digest" in *[!0-9a-f]*) echo 'Invalid checksum digest.' >&2; exit 1 ;; esac
if [ "$checksum" = sha256sum ]; then
  (cd "$temporary" && sha256sum -c checksum >/dev/null)
else
  (cd "$temporary" && shasum -a 256 -c checksum >/dev/null)
fi
# Check the archive's paths before extraction; all files must stay inside one directory.
tar -tzf "$temporary/$archive" > "$temporary/files"
awk '$0 !~ /^infomentor-mcp\// || $0 ~ /(^|\/)\.\.(\/|$)/ { exit 1 }' "$temporary/files"
tar -xzf "$temporary/$archive" -C "$temporary"
[ "$("$temporary/infomentor-mcp/bin/infomentor-mcp" --version)" = "$version" ] || { echo 'Release version mismatch.' >&2; exit 1; }
digest=$(cut -c 1-16 "$temporary/checksum")
case "$digest" in ''|*[!0-9a-f]*) echo 'Invalid checksum.' >&2; exit 1 ;; esac
install_dir="$prefix/share/infomentor-mcp/$version-$digest"
mkdir -p "$prefix/share/infomentor-mcp" "$prefix/bin"
if [ -e "$install_dir" ]; then
  [ "$("$install_dir/bin/infomentor-mcp" --version)" = "$version" ] || { echo 'Existing installation is invalid.' >&2; exit 1; }
fi
if [ -d "$prefix/bin/infomentor-mcp" ]; then echo 'The command path is a directory; installation stopped.' >&2; exit 1; fi
entrypoint=infomentor-mcp
if [ "$network" = warp ]; then
  # Administrator code always comes from this freshly verified download.
  setup="$temporary/infomentor-mcp/libexec/warp.sh"
  [ -f "$setup" ] || { echo 'This release does not include WARP setup.' >&2; exit 1; }
  if [ "$(id -u)" = 0 ]; then sh "$setup" install </dev/null
  else sudo sh "$setup" install </dev/null
  fi
  entrypoint=infomentor-mcp-warp
fi
if [ ! -e "$install_dir" ]; then mv "$temporary/infomentor-mcp" "$install_dir"; fi
ln -s "$install_dir/bin/$entrypoint" "$temporary/command"
mv -f "$temporary/command" "$prefix/bin/infomentor-mcp"
printf '%s\n' "$network" > "$temporary/network"
mv -f "$temporary/network" "$prefix/share/infomentor-mcp/network"
printf 'Installed infomentor-mcp %s at %s/bin/infomentor-mcp\n' "$version" "$prefix"
printf 'Use that absolute command path in your MCP client. Direct HTTP login is available through MCP.\n'
case ":${PATH:-}:" in *":$prefix/bin:"*) ;; *) printf 'For terminal use, add %s/bin to PATH.\n' "$prefix" ;; esac
