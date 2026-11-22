import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'shapez1-live-verification', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/server.mjs'],
  env: { SHAPEZ_MODE: 'observe' },
});
const budgets = { status: 2, entities: 16, resources: 12, map_region: 96, game: 96 };

async function call(name, args = {}, expectedError) {
  const result = await client.callTool({ name, arguments: args });
  const payload = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  if (expectedError) {
    assert.equal(result.isError, true);
    assert.equal(payload.error.code, expectedError);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
    return payload.error;
  }
  assert.ok(!result.isError, payload.error?.code);
  const budget = budgets[name] * 1024;
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= budget);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4 * budget + 1024);
  return payload.data;
}

function entityBucket(row) {
  const { kind } = row;
  if (kind === 'belt') return 'Belt';
  if (kind === 'hub') return 'Hub';
  if (kind === 'underground') return 'UndergroundBelt';
  if (kind === 'processor') return 'ItemAcceptor,ItemEjector,ItemProcessor';
  if (kind === 'miner' || kind === 'ejector') return 'ItemEjector';
  return 'Unknown';
}

async function verifyView(tool, summary) {
  const rows = new Set();
  const counts = new Map();
  let cursor = summary.firstCursor;
  let pages = 0;
  let previous;
  let first;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  while (cursor) {
    const page = await call(tool, { mode: 'page', cursor });
    assert.equal(page.total, summary.total);
    assert.equal(page.view, summary.view);
    assert.ok(page.rows.length >= 1 && page.rows.length <= 64);
    for (const row of page.rows) {
      assert.ok(!rows.has(row.row), 'duplicate (view, row)');
      rows.add(row.row);
      const { x, y } = row.tile ?? row.centerTile;
      if (previous) assert.ok(y > previous.y || (y === previous.y && x >= previous.x));
      previous = { x, y };
      first ??= row;
      const key = row.key ?? entityBucket(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      x0 = Math.min(x0, Math.floor(x));
      y0 = Math.min(y0, Math.floor(y));
      x1 = Math.max(x1, Math.floor(x) + 1);
      y1 = Math.max(y1, Math.floor(y) + 1);
      if (row.chunk) {
        assert.equal(Math.floor(x / 16), row.chunk.x);
        assert.equal(Math.floor(y / 16), row.chunk.y);
      }
    }
    cursor = page.next;
    pages++;
  }
  assert.equal(rows.size, summary.total);
  const ordered = [...counts].sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : Number(a > b)));
  assert.deepEqual(ordered.slice(0, 24), summary.groups.map(group => [group.key, group.count]));
  assert.equal(ordered.slice(24).reduce((n, [, count]) => n + count, 0), summary.other);
  assert.deepEqual(summary.bbox, summary.total ? { x0, y0, x1, y1 } : null);
  console.log(JSON.stringify({ tool, total: rows.size, pages, bbox: summary.bbox }));
  return first;
}

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'shapez1-cdp-agent');
  assert.equal((await client.listTools()).tools.length, 11);
  const status = await call('status');
  console.log(JSON.stringify({ at: new Date().toISOString(), ...status }));
  const { visibleTiles } = status.camera;
  const x = Math.floor((visibleTiles.x0+visibleTiles.x1)/32)*16;
  const y = Math.floor((visibleTiles.y0+visibleTiles.y1)/32)*16;
  const region = [x,y,x+16,y+16];
  for (const tool of ['entities','resources']) {
    const summary = await call(tool,{mode:'summary',region});
    await verifyView(tool,summary);
  }
  const map = await call('map_region',{region});
  assert.ok(Array.isArray(map.rows) && Array.isArray(map.ground));
  const picture = await client.callTool({name:'map_region', arguments:{region,format:'image'}});
  assert.ok(picture.content.some(block => block.type === 'image'), JSON.stringify(picture.structuredContent));
  const speeds = await call('game',{op:'speeds'});
  assert.ok(speeds.belt > 0 && speeds.fullBelt.miner > 0);
  const machines = await call('game',{op:'catalog',id:'painter'});
  assert.ok(machines.entries.some(row => row[2] === 'quad' && row.at(-1).length === 4));
  await call('entities', { mode: 'region', region: { x0: 100000, y0: 0, x1: 100001, y1: 1 } }, 'REGION_OUT_OF_BOUNDS');
  await call('apply_belts', { plan: 'unused', requestId: 'verify-live-0001' }, 'READ_ONLY');
  assert.equal((await call('status')).epoch, status.epoch);
  console.log('Live stdio verification passed.');
} finally {
  await client.close();
}
