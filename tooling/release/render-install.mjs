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
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stop-running) stop_running=true ;;
      --with-warp) [ -z "$network" ] || { echo 'Usage: install.sh [--with-warp|--without-warp] [--stop-running]' >&2; exit 1; }; network=warp ;;
      --without-warp) [ -z "$network" ] || { echo 'Usage: install.sh [--with-warp|--without-warp] [--stop-running]' >&2; exit 1; }; network=direct ;;
      *) echo 'Usage: install.sh [--with-warp|--without-warp] [--stop-running]' >&2; exit 1 ;;
    esac
    shift
  done`
      : `  case "$#" in
    0) ;;
    1) [ "$1" = --stop-running ] || { echo 'Usage: install.sh [--stop-running]' >&2; exit 1; }; stop_running=true ;;
    *) echo 'Usage: install.sh [--stop-running]' >&2; exit 1 ;;
  esac`,
    NETWORK: warp
      ? `  [ -n "$network" ] || network=$(cat "$prefix/share/${pkg.name}/network" 2>/dev/null || printf direct)
  case "$network" in direct|warp) ;; *) echo 'Invalid saved network setting.' >&2; exit 1 ;; esac
  if [ "$network" = warp ] && { [ "$platform" != linux ] || [ "$arch" != x64 ]; }; then echo 'Automatic WARP setup supports Debian 13 on x64.' >&2; exit 1; fi`
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
