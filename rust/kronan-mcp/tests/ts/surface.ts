// Regenerates src/surface.json, the TypeScript server's instructions and tools/list that the Rust
// server replays: `bun tests/ts/surface.ts > src/surface.json`. parity.ts fails when they differ.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createServer } from '../../../../packages/kronan-mcp/src/server.ts';

const server = createServer();
const client = new Client({ name: 'kronan-parity', version: '1.0.0' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
console.log(JSON.stringify({ instructions: client.getInstructions(), tools }, null, 1));

await client.close();
await server.close();
