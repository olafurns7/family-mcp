// Regenerates src/surface.json, the TypeScript server's instructions and tools/list plus the
// documented Rust-only tools, which the Rust server replays:
// `bun tests/ts/surface.ts > src/surface.json`. It lists the setup tools too; the Rust server
// leaves them out unless started with --allow-setup-tools. parity.ts fails when they differ.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createServer } from '../../../../packages/infomentor-mcp/src/server.ts';

import { rustOnlyTools } from './rust-only-tools.ts';

const server = createServer({ allowSetupTools: true });
const client = new Client({ name: 'infomentor-parity', version: '1.0.0' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
// After infomentor_get_notifications, before infomentor_collect_updates.
tools.splice(6, 0, ...rustOnlyTools);
console.log(JSON.stringify({ instructions: client.getInstructions(), tools }, null, 1));

await client.close();
await server.close();
