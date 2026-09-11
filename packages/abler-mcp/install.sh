#!/bin/sh
set -eu

# Run only after the complete script has been read when invoked through curl | sh.
main() {
  version=0.3.1
  prefix=${ABLER_PREFIX:-${HOME:?Set HOME or ABLER_PREFIX}/.local}
  case "$prefix" in
    /*) ;;
    *) printf '%s\n' 'ABLER_PREFIX must be an absolute path.' >&2; exit 1 ;;
  esac
  for tool in curl tar mktemp uname; do
    command -v "$tool" >/dev/null 2>&1 || {
      printf 'Required command missing: %s\n' "$tool" >&2
      exit 1
    }
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    checksum_tool='shasum -a 256'
  else
    printf '%s\n' 'Install sha256sum or shasum, then retry.' >&2
    exit 1
  fi
  case "$(uname -s)" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) printf '%s\n' 'Supported systems: macOS and Linux.' >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) printf '%s\n' 'Supported CPUs: arm64 and x64.' >&2; exit 1 ;;
  esac

  abler_tmp=$(mktemp -d "${TMPDIR:-/tmp}/abler-install.XXXXXX")
  destination=
  trap 'rm -rf "$abler_tmp"; if [ -n "$destination" ]; then rm -f "$destination"; fi' 0
  trap 'exit 1' 1 2 15
  archive="abler-mcp-$version-$platform-$arch.tar.gz"
  release="https://github.com/olafurns7/abler-mcp/releases/download/v$version"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$release/$archive" -o "$abler_tmp/$archive"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$release/$archive.sha256" -o "$abler_tmp/$archive.sha256"
  actual=$(cd "$abler_tmp" && $checksum_tool "$archive")
  [ "$actual" = "$(cat "$abler_tmp/$archive.sha256")" ] || {
    printf '%s\n' 'Release checksum verification failed; nothing was installed.' >&2
    exit 1
  }

  mkdir -p "$prefix/bin"
  [ ! -d "$prefix/bin/abler-mcp" ] || {
    printf '%s\n' 'Install destination is a directory; nothing was replaced.' >&2
    exit 1
  }
  destination=$(mktemp "$prefix/bin/.abler-mcp.XXXXXX")
  # Read named members to fresh files; archive paths and symlinks are never extracted.
  tar -xOzf "$abler_tmp/$archive" abler-mcp > "$destination"
  chmod 755 "$destination"
  [ "$("$destination" --version </dev/null)" = "$version" ] || {
    printf '%s\n' 'Downloaded executable cannot run or returned an unexpected version; previous installation kept.' >&2
    exit 1
  }
  tar -xOzf "$abler_tmp/$archive" LICENSE > "$abler_tmp/LICENSE"
  tar -xOzf "$abler_tmp/$archive" THIRD_PARTY_NOTICES.txt > "$abler_tmp/THIRD_PARTY_NOTICES.txt"
  mkdir -p "$prefix/share/abler-mcp"
  cp "$abler_tmp/LICENSE" "$abler_tmp/THIRD_PARTY_NOTICES.txt" "$prefix/share/abler-mcp/"
  mv -f "$destination" "$prefix/bin/abler-mcp"
  destination=
  printf 'Installed abler-mcp %s at %s/bin/abler-mcp\n' "$version" "$prefix"
  printf 'Use that absolute path in your MCP client. Authentication setup: https://github.com/olafurns7/abler-mcp#authenticate-once-then-run-headlessly\n'
  case ":${PATH:-}:" in
    *":$prefix/bin:"*) ;;
    *) printf 'For terminal use, add %s/bin to PATH.\n' "$prefix" ;;
  esac
}

main "$@"
