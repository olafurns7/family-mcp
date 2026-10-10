// First case is the unchanged TS public-menu/MCP integration case, with the transport replaced.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import manifest from '../../../../packages/dominos-mcp/package.json';
import { parseMenu } from '../../../../packages/dominos-mcp/src/catalog.ts';
import { profileResult } from '../../../../packages/dominos-mcp/src/schemas.ts';
import { html, cart, setup } from './fixtures.ts';
test('public menu parsing never evaluates JavaScript and MCP results omit secrets', async () => {
  assert.equal(parseMenu(html).menuPizzas[0]?.id, 'TEST');
  assert.throws(() => parseMenu('ReactDOM.hydrate({menu: malicious()})'));
  const fixture = await setup();
  // Rust: stdio binary in place of the reference in-memory server.
  const server = await fixture.client.serve();
  const mcp = new Client({ name: 'offline-test', version: '1' });

  try {
    await mcp.connect(server.transport);
    const { tools } = await mcp.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).toSorted(),
      [...manifest.familyMcp.release.tools].toSorted(),
    );
    assert.ok(tools.every((tool) => tool.outputSchema));
    assert.equal(
      tools.find((tool) => tool.name === 'quote_order')?.annotations?.idempotentHint,
      false,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'pay_saved_card')?.annotations?.readOnlyHint,
      false,
    );
    const accountResult = await mcp.callTool({ name: 'get_profile', arguments: {} });

    const menuResult = await mcp.callTool({
      name: 'search_menu',
      arguments: { query: 'synthetic' },
    });

    assert.equal(accountResult.isError, undefined);
    assert.deepEqual(profileResult.parse(accountResult.structuredContent).addresses, [
      { ID: 42, Name: 'Test street 7', PostalCode: '100', PostalCodeName: 'Test city' },
    ]);
    assert.equal(menuResult.isError, undefined);
    assert.ok(!JSON.stringify([accountResult, menuResult]).includes('DO-NOT-RETURN'));
    assert.equal(
      (await mcp.callTool({ name: 'quote_order', arguments: { ...cart, IsFinal: true } })).isError,
      true,
    );
  } finally {
    await mcp.close();
    await server.close();
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

