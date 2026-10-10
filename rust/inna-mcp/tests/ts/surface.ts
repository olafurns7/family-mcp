// Regenerates src/surface.json, the TypeScript server's instructions and tools/list with
// --allow-absence-writes, which the Rust server replays: `bun tests/ts/surface.ts > src/surface.json`.
// Without the flag the Rust server leaves out the two absence write tools, as the TypeScript
// server does. parity.ts fails when either list differs.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createServer } from '../../../../packages/inna-mcp/src/server.ts';

const server = createServer({ allowAbsenceWrites: true });
const client = new Client({ name: 'inna-parity', version: '1.0.0' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
console.log(JSON.stringify({ instructions: client.getInstructions(), tools }, null, 1));

await client.close();
await server.close();
