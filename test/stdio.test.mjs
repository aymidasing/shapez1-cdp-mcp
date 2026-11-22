import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

test('official stdio client negotiates and lists tools with CDP unavailable', async () => {
  const client = new Client({ name: 'shapez1-test', version: '1' });
  const noCdp = 'data:text/javascript,' + encodeURIComponent(`
    globalThis.fetch = async () => { throw new Error('Offline fixture'); };
    globalThis.WebSocket = class { constructor() { throw new Error('Unexpected socket'); } };
  `);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', noCdp, 'dist/server.mjs'],
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'shapez1-cdp-agent');
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'map_region'));
    assert.equal(tools.length, 11);
    const invalid = await client.callTool({ name: 'entities', arguments: { mode: 'page', limit: 65 } })
      .catch(error => error);
    assert.equal(invalid.code, ErrorCode.InvalidParams);
    const result = await client.callTool({ name: 'status' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'CDP_UNREACHABLE');
    assert.equal(result.structuredContent.error.inGame, null);
    assert.equal(Object.keys(result.structuredContent).join(), 'error');
  } finally {
    await client.close();
  }
});
