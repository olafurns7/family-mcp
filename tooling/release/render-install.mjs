import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readPackage } from './package.mjs';

/** @param {Awaited<ReturnType<typeof readPackage>>} pkg */
export async function renderInstall(pkg) {
  const warp = pkg.familyMcp.release.extraFiles.some(
    (file) => file.destination === 'libexec/warp.sh',
  );

  const extraFiles = pkg.familyMcp.release.extraFiles
    .map(
      (file) => `  if [ "$platform" = '${file.platform}' ]; then
    mkdir -p "$staging/${dirname(file.destination)}"
    tar -xOzf "$temporary/$archive" '${pkg.name}/${file.destination}' > "$staging/${file.destination}"
    chmod ${file.executable ? '755' : '644'} "$staging/${file.destination}"
  fi`,
    )
    .join('\n');

  const replacements = {
    NAME: pkg.name,
    SHORT: pkg.name.replace('-mcp', ''),
    ENV: pkg.envPrefix,
    VERSION: pkg.version,
    OPTIONS: warp
      ? `  network=''
  remove_direct_route=false
  usage='Usage: install.sh [--with-direct-route|--without-direct-route|--with-warp|--without-warp] [--stop-running]'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stop-running) stop_running=true ;;
      --with-direct-route) [ -z "$network" ] || { echo "$usage" >&2; exit 1; }; network=direct-route ;;
      --without-direct-route) [ -z "$network" ] || { echo "$usage" >&2; exit 1; }; network=direct; remove_direct_route=true ;;
      --with-warp) [ -z "$network" ] || { echo "$usage" >&2; exit 1; }; network=warp ;;
      --without-warp) [ -z "$network" ] || { echo "$usage" >&2; exit 1; }; network=direct ;;
      *) echo "$usage" >&2; exit 1 ;;
    esac
    shift
  done`
      : `  case "$#" in
    0) ;;
    1) [ "$1" = --stop-running ] || { echo 'Usage: install.sh [--stop-running]' >&2; exit 1; }; stop_running=true ;;
    *) echo 'Usage: install.sh [--stop-running]' >&2; exit 1 ;;
  esac`,
    NETWORK: warp
      ? `  previous_network=$(cat "$prefix/share/${pkg.name}/network" 2>/dev/null || printf direct)
  [ -n "$network" ] || network=$previous_network
  case "$network" in direct|warp|direct-route) ;; *) echo 'Invalid saved network setting.' >&2; exit 1 ;; esac
  if [ "$network" = warp ] && { [ "$platform" != linux ] || [ "$arch" != x64 ]; }; then echo 'Automatic WARP setup supports Debian 13 on x64.' >&2; exit 1; fi
  if [ "$previous_network" = direct-route ] && [ "$network" != direct-route ]; then remove_direct_route=true; fi
  if [ "$network" = direct-route ] || [ "$remove_direct_route" = true ]; then
    [ "$platform" = linux ] && [ -x /usr/bin/python3 ] || { echo 'Direct-route setup requires Linux with /usr/bin/python3.' >&2; exit 1; }
  fi`
      : '',
    EXTRA_FILES: extraFiles,
    POST_INSTALL: warp
      ? `  if [ "$network" = warp ]; then
    # Administrator code always comes from the freshly verified named archive member.
    cp "$staging/libexec/warp.sh" "$temporary/warp.sh"
    if [ "$(id -u)" = 0 ]; then sh "$temporary/warp.sh" install </dev/null
    else sudo sh "$temporary/warp.sh" install </dev/null
    fi
    entrypoint=${pkg.name}-warp
  fi
  if [ "$network" = direct-route ] || [ "$remove_direct_route" = true ]; then
    cp "$staging/libexec/direct-route.py" "$temporary/direct-route.py"
    if [ "$network" = direct-route ]; then route_action=install; else route_action=remove; fi
    if [ "$(id -u)" = 0 ]; then /usr/bin/python3 -I "$temporary/direct-route.py" "$route_action" </dev/null
    else sudo /usr/bin/python3 -I "$temporary/direct-route.py" "$route_action" </dev/null
    fi
  fi`
      : '',
    SAVE_NETWORK: warp
      ? `  printf '%s\\n' "$network" > "$temporary/network"
  mv -f "$temporary/network" "$prefix/share/${pkg.name}/network"`
      : '',
  };

  let output = await readFile(new URL('./install.sh.template', import.meta.url), 'utf8');

  for (const [key, value] of Object.entries(replacements))
    output = output.replaceAll(`@@${key}@@`, value);
  assert.ok(!output.includes('@@'), 'Unresolved installer template token.');

  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { package: { type: 'string' }, check: { type: 'boolean' } },
  });

  const pkg = await readPackage(values.package);
  const output = await renderInstall(pkg);
  const path = join(pkg.root, 'install.sh');

  if (values.check)
    assert.equal(await readFile(path, 'utf8'), output, `Regenerate ${pkg.name}/install.sh.`);
  else await writeFile(path, output);
}
