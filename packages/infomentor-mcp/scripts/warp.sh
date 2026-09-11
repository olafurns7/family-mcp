#!/bin/sh
# Optional, headless Cloudflare client setup. No school credentials are handled here.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
base=/opt/infomentor-warp
helper=/usr/local/libexec/infomentor-warp
cli="$base/bin/warp-cli"
mode=${1:-status}
fail() { echo "$*" >&2; exit 1; }
warp() { timeout 20 "$cli" --accept-tos "$@"; }
status() { warp status 2>/dev/null | grep -q '^Network: healthy$'; }
[ "$mode" != status ] || { status; exit; }
[ "$(id -u)" = 0 ] || fail 'WARP setup needs administrator access.'
exec 1>&2

prepare() {
  mkdir -p /var/lib/cloudflare-warp /var/log/cloudflare-warp /run/cloudflare-warp
  chmod 700 /var/lib/cloudflare-warp
  # Keep this tunnel independent of an existing Tailscale exit node.
  for destination in 162.159.198.0/24 $(getent ahostsv4 api.cloudflareclient.com | awk '{print $1}' | sort -u); do
    if ! ip rule show | grep '^5180:' | grep -Fq "to $destination lookup main"; then
      ip rule add pref 5180 to "$destination" lookup main
    fi
  done
}

start() {
  mkdir -p /run
  exec 9>/run/infomentor-warp.lock
  flock -w 45 9 || fail 'Another WARP setup is still running.'
  prepare
  if [ -d /run/systemd/system ]; then
    systemctl start infomentor-warp.service
  elif ! pgrep -f '^/opt/infomentor-warp/bin/warp-svc$' >/dev/null; then
    ! pgrep -x warp-svc >/dev/null || fail 'Another WARP daemon is running; its configuration was left unchanged.'
    # ponytail: without systemd, recover daemon failures on the next MCP launch.
    rm -f /run/cloudflare-warp/warp_service
    setsid "$base/bin/warp-svc" </dev/null >/dev/null 2>&1 9>&- &
  fi
  attempt=0
  until [ -S /run/cloudflare-warp/warp_service ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 15 ] || fail 'The WARP daemon did not start.'
    sleep 1
  done
  configure=0
  if ! warp registration show >/dev/null 2>&1; then
    warp registration new >/dev/null
    configure=1
  fi
  if [ "$mode" = install ] || [ "$configure" = 1 ]; then
    warp mode proxy >/dev/null
    warp proxy port 18443 >/dev/null
    warp tunnel protocol set MASQUE >/dev/null
  fi
  warp connect >/dev/null
  ready_until=$(($(date +%s) + 40))
  # A healthy tunnel can precede application readiness after a reconnect.
  until status && curl --proxy http://127.0.0.1:18443 --noproxy '' --connect-timeout 3 --max-time 6 --fail --silent --output /dev/null --output /dev/null https://im1.infomentor.is/production/mentor/ https://minn.infomentor.is/; do
    [ "$(date +%s)" -lt "$ready_until" ] || fail 'WARP could not establish a verified InfoMentor connection.'
    sleep 1
  done
}

case "$mode" in
  prepare) prepare ;;
  start) [ -f "$base/owned" ] || fail 'Run the installer with --with-warp first.'; start ;;
  install)
    # ponytail: validated Debian 13/x64 package only; add other builds after live validation.
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'Automatic WARP setup supports Debian 13 on x64.'
    . /etc/os-release
    [ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] || fail 'Automatic WARP setup supports Debian 13 on x64.'
    if [ ! -f "$base/owned" ]; then
      [ ! -e /var/lib/cloudflare-warp ] && ! command -v warp-cli >/dev/null && ! pgrep -x warp-svc >/dev/null || fail 'An existing WARP installation was found. Its configuration was left unchanged; configure HTTPS_PROXY manually instead.'
    fi
    temporary=$(mktemp -d /tmp/infomentor-warp-install.XXXXXX)
    trap 'rm -rf "$temporary"' EXIT
    trap 'exit 1' HUP INT TERM
    if [ ! -x "$cli" ] || [ "$("$cli" --version)" != 'warp-cli 2026.7.1377.0' ]; then
      curl --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 -fsSL https://pkg.cloudflareclient.com/pool/trixie/main/c/cloudflare-warp/cloudflare-warp_2026.7.1377.0_amd64.deb -o "$temporary/warp.deb"
      printf '%s  %s\n' 5afe38d0536b49bd09509264b68018e5440b28538323e1984d8096c512062658 "$temporary/warp.deb" | sha256sum -c -
      apt-get update -qq
      # Install daemon libraries only; the desktop client and its browser UI are unnecessary.
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libdbus-1-3 libtss2-esys-3.0.2-0t64 libtss2-tctildr0t64 iproute2 util-linux procps ca-certificates
      dpkg-deb -x "$temporary/warp.deb" "$temporary/package"
      install -d -m 755 "$base/bin"
      install -m 755 "$temporary/package/bin/warp-cli" "$temporary/package/bin/warp-svc" "$base/bin/"
    fi
    touch "$base/owned"
    install -d -m 755 /usr/local/libexec
    [ "$0" = "$helper" ] || install -m 755 "$0" "$helper"
    if [ -d /run/systemd/system ]; then
      cat > /etc/systemd/system/infomentor-warp.service <<'UNIT'
[Unit]
Description=Cloudflare WARP local proxy for InfoMentor MCP
Wants=network-online.target
After=network-online.target

[Service]
ExecStartPre=/usr/local/libexec/infomentor-warp prepare
ExecStart=/opt/infomentor-warp/bin/warp-svc
Restart=on-failure
StateDirectory=cloudflare-warp
RuntimeDirectory=cloudflare-warp
LogsDirectory=cloudflare-warp

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable infomentor-warp.service
    fi
    start
    echo 'WARP is ready for InfoMentor on 127.0.0.1:18443.'
    ;;
  *) fail 'Usage: infomentor-warp status|start|prepare|install' ;;
esac
