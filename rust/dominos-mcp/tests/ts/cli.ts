// Bun consumes a leading '--' after a script; restore the arguments parseArgs would see in a
// compiled CLI so the parity cases measure the package, including its end-of-options marker.
const cli = new URL('../../../../packages/dominos-mcp/src/cli.ts', import.meta.url).pathname;
process.argv = [process.execPath, cli, ...JSON.parse(process.argv[2]!)];
await import(cli);
