#!/bin/sh
set -eu
directory=$(dirname "$(readlink -f "$0")")
case "${1:-serve}" in
  --version|--help|-h) exec "$directory/infomentor-mcp" "$@" ;;
esac
if ! /usr/local/libexec/infomentor-warp status </dev/null; then
  sudo -n /usr/local/libexec/infomentor-warp start </dev/null >&2 || {
    echo 'WARP is unavailable. Run the installer with --with-warp to restore it.' >&2
    exit 1
  }
fi
exec env HTTPS_PROXY=http://127.0.0.1:18443 https_proxy=http://127.0.0.1:18443 \
  HTTP_PROXY=http://127.0.0.1:18443 http_proxy=http://127.0.0.1:18443 NO_PROXY= no_proxy= \
  "$directory/infomentor-mcp" "$@"
