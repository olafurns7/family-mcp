#!/bin/sh
set -eu

version=$(bun -p 'require("./package.json").version')
platform=$(bun -p 'process.platform')
arch=$(bun -p 'process.arch')
archive="abler-mcp-$version-$platform-$arch.tar.gz"
target="bun-$platform-$arch"
case "$arch" in x64) target="$target-baseline" ;; esac
mkdir -p release/native
bun build --compile --target "$target" --minify --sourcemap \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  src/cli.ts --outfile release/native/abler-mcp
cp LICENSE release/native/LICENSE
cp docs/THIRD_PARTY_NOTICES.txt release/native/THIRD_PARTY_NOTICES.txt
COPYFILE_DISABLE=1 tar -czf "release/$archive" -C release/native abler-mcp LICENSE THIRD_PARTY_NOTICES.txt
cd release
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" > "$archive.sha256"
else
  shasum -a 256 "$archive" > "$archive.sha256"
fi
