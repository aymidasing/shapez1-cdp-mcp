import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { bindRenderer } from '../dist/renderer.mjs';
import { holdGameFrame, waitForGameFrame } from '../dist/screenshot.mjs';

const url = 'file:///steam/shapez.io/resources/app.asar/index.html';
const status = JSON.parse(readFileSync(new URL('../dist/contracts.json', import.meta.url), 'utf8'))[0];
const fixtureId = 'fixture-save-id';

function fixture() {
  const app = { stateMgr: { getCurrentState: () => live } };
  const save = { internalId: fixtureId };
  const live = { app, getKey: () => 'InGameState', stage: 's10_gameRunning', savegame: save };
  const entity = (x, y, keys) => ({
    components: {
      StaticMapEntity: { origin: { x, y }, rotation: 0, getRotationVariant: () => keys.includes('Belt') ? 1 : 0 },
      ...Object.fromEntries(keys.map(key => [key, {}])),
    },
  });
  const entities = [
    ...Array.from({ length: 1982 }, () => entity(-125, -377, ['Belt'])),
    ...Array.from({ length: 155 }, () => entity(-9, -4, ['ItemEjector'])),
    ...Array.from({ length: 74 }, () => entity(-8, -4, ['ItemAcceptor', 'ItemEjector', 'ItemProcessor'])),
    ...Array.from({ length: 2 }, () => entity(103, 163, ['UndergroundBelt'])),
    entity(0, 0, ['Hub']),
  ];
  const chunksById = new Map();
  for (let y = -11; y <= 10; y++) {
    for (let x = -11; x <= 10; x++) {
      chunksById.set(x + '|' + y, { x, y, tileX: x * 16, tileY: y * 16, patches: [] });
    }
  }
  const red = { getItemType: () => 'color', color: 'red' };
  const shape = { getItemType: () => 'shape', definition: { getHash: () => 'CuCuCuCu' } };
  chunksById.get('-1|-1').patches.push(...Array.from({ length: 84 }, () => ({ item: red, size: 2, pos: { x: 4.5, y: 9.5 } })));
  chunksById.get('1|1').patches.push(...Array.from({ length: 85 }, () => ({ item: shape, size: 3, pos: { x: 0, y: 0 } })));
  live.core = { root: {
    app, gameState: live, savegame: save, entityMgr: { entities }, map: { chunksById },
    hubGoals: { level: 10 }, camera: {
      center: { x: 0, y: 0 }, zoomLevel: 1, getVisibleRect: () => ({ x: -33, y: -1, w: 66, h: 33 }),
    },
  } };

  const wrong = {
    stateMgr: { getCurrentState: () => null },
    get savegameMgr() { throw new Error('Save enumeration forbidden'); },
    get core() { throw new Error('Stale world access forbidden'); },
  };
  const time = { now: 0 };
  const context = {
    top: {}, location: { href: url }, TextEncoder, Date: { now: () => time.now },
    setTimeout: () => 0, clearTimeout() {},
  };
  context.self = context.top;
  const bind = runInNewContext('(' + bindRenderer.toString() + ')', context);
  const dispatch = bind.call([wrong, app], { href: url, seed: 'fixture', mode: 'observe' });
  let id = 0;
  const call = (tool, query = {}, options = {}) => JSON.parse(JSON.stringify(
    dispatch({ tool, query, view: String(++id), ...options }),
  ));
  return { live, save, call, entities, chunksById, time };
}

function allRows(call, tool, summary) {
  let position = summary.position;
  const rows = [];
  while (position) {
    const page = call(tool, { mode: 'page', cursor: 'test' }, { position });
    assert.equal(page.data.view, summary.data.view);
    assert.equal(page.data.total, summary.data.total);
    rows.push(...page.data.rows);
    position = page.position;
  }
  assert.equal(rows.length, summary.data.total);
  assert.equal(new Set(rows.map(row => row.row)).size, rows.length);
  return rows;
}

test('historical fixture reconciles the frozen summaries and all pages', () => {
  const { call, entities, chunksById } = fixture();
  const status = call('status').data;
  assert.equal(status.level, 10);
  assert.equal(status.entityCount, 2214);
  assert.equal(status.loadedChunks, 484);
  assert.deepEqual(status.camera.visibleTiles, { x0: -2, y0: -1, x1: 2, y1: 1 });
  const entity = call('entities', { mode: 'summary' });
  const resources = call('resources', { mode: 'summary' });
  assert.deepEqual(entity.data.groups.map(group => group.count), [1982, 155, 74, 2, 1]);
  assert.deepEqual(entity.data.bbox, { x0: -125, y0: -377, x1: 104, y1: 164 });
  assert.equal(resources.data.total, 169);
  entities.length = 0;
  chunksById.get('-1|-1').patches.length = 0;
  const listed = allRows(call, 'entities', entity);
  assert.equal(listed.find(row => row.tile.x === -9).kind, 'ejector');
  assert.equal(listed[0].rotationVariant, 1);
  const patches = allRows(call, 'resources', resources);
  assert.deepEqual(patches[0].centerTile, { x: -11.5, y: -6.5 });
  assert.deepEqual(patches.at(-1).centerTile, { x: 16, y: 16 });
});

test('a save change during paint or before the capture checkpoint aborts the screenshot', async () => {
  const queue = [];
  const wait = runInNewContext('(' + waitForGameFrame.toString() + ')', {
    requestAnimationFrame(fn) { queue.push(fn); return queue.length; },
    cancelAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {},
  });
  const cmd = { tool: 'screenshot', query: {}, view: 'test' };
  let current = { data: { epoch: 'first' } };
  const guard = () => current;
  const pending = wait.call(guard, cmd);
  queue.shift()();
  current = { fault: 'SAVE_ID_MISMATCH', inGame: true };
  queue.shift()();
  assert.equal((await pending).fault, 'SAVE_ID_MISMATCH');
  assert.equal(holdGameFrame.call(guard, cmd, 'first').fault, 'SAVE_ID_MISMATCH');
  current = { data: { epoch: 'reloaded' } };
  assert.equal(holdGameFrame.call(guard, cmd, 'first').fault, 'SESSION_CHANGED');
});

test('coverage uses half-open tile coordinates and distinguishes unloaded from empty', () => {
  const { call, chunksById } = fixture();
  const query = region => call('entities', { mode: 'summary', region });
  assert.equal(query({ x0: -1, y0: -1, x1: 0, y1: 0 }).data.total, 0);
  assert.equal(query({ x0: -1, y0: -1, x1: 1, y1: 1 }).data.total, 1);
  assert.equal(query({ x0: 0, y0: 0, x1: 0, y1: 1 }).fault, 'REGION_INVALID');
  chunksById.delete('1|0');
  assert.equal(query({ x0: 15, y0: 0, x1: 16, y1: 1 }).data.total, 0);
  assert.equal(query({ x0: 15, y0: 0, x1: 17, y1: 1 }).fault, 'REGION_OUT_OF_BOUNDS');
  assert.equal(chunksById.size, 483);
});

test('all nine commands stop at the identity guard when root and state disagree', () => {
  const { call, live } = fixture();
  const first = call('entities', { mode: 'summary' });
  let attempts = 0;
  live.savegame = { internalId: fixtureId };
  for (const tool of ['status', 'entities', 'resources', 'sample_flow', 'screenshot', 'game']) {
    assert.deepEqual(call(tool), { fault: 'IDENTITY_UNKNOWN', inGame: true });
  }
  assert.equal(call('entities', { mode: 'page', cursor: 'test' }, first).fault, 'IDENTITY_UNKNOWN');
  live.getKey = () => 'MainMenuState';
  Object.defineProperty(live, 'savegame', { get() { attempts++; throw new Error('Menu save touched'); } });
  assert.deepEqual(call('status'), { fault: 'NOT_IN_GAME', inGame: false });
  assert.equal(attempts, 0);
});

test('root replacement, unknown ownership, expired cursors and read-only requests fail closed', () => {
  const { call, live, time } = fixture();
  const summary = call('resources', { mode: 'summary' });
  const epoch = call('status').data.epoch;
  live.core.root = { ...live.core.root };
  assert.notEqual(call('status').data.epoch, epoch);
  const page = (position, options = {}) => call('resources', { mode: 'page', cursor: 'test' }, { position, ...options });
  assert.equal(page(summary.position).fault, 'SESSION_CHANGED');
  assert.equal(page(undefined).fault, 'CURSOR_INVALID');
  const old = call('resources', { mode: 'summary' });
  time.now += 120_000;
  assert.equal(page(old.position).fault, 'CURSOR_INVALID');
  assert.equal(page(old.position, { previousConnection: true }).fault, 'SESSION_CHANGED');
  assert.equal(call('screenshot').fault, 'CAPTURE_FAILED');
  live.core.root = { ...live.core.root, gameState: {} };
  assert.equal(call('status').fault, 'IDENTITY_UNKNOWN');
});

test('upstream trace follows facing ports through an empty buffer to a backed-up cutter outlet',()=>{
  const {call,live}=fixture();
  const map=new Map(), slot=direction=>({pos:{x:0,y:0},direction});
  function put(x,y,id,c){
    const e={components:{StaticMapEntity:{origin:{x,y},getMetaBuilding:()=>({getId:()=>id}),
      localTileToWorld:()=>({x,y}),localDirectionToWorld:d=>d},...c}};
    map.set([x,y].join(),e);return e;
  }
  live.core.root.map.getLayerContentXY=(x,y)=>map.get([x,y].join());
  const storage=put(0,-1,'storage',{ItemAcceptor:{slots:[slot('bottom')]},Storage:{storedCount:5000,getIsFull:()=>true}});
  put(0,0,'cutter',{ItemProcessor:{type:'cutterQuad',inputSlots:new Map(),ongoingCharges:[],queuedEjects:[{}]},
    ItemEjector:{slots:[{...slot('top'),item:{},progress:1},slot('right')]}});
  put(1,0,'storage',{Storage:{storedCount:0},ItemAcceptor:{slots:[slot('left')]},ItemEjector:{slots:[slot('right')]}});
  put(2,0,'painter',{ItemAcceptor:{slots:[{...slot('left'),filter:'shape'}]},ItemEjector:{slots:[slot('right')]},
    ItemProcessor:{type:'painter',inputSlots:new Map(),queuedEjects:[],ongoingCharges:[]}});
  const trace=()=>call('game',{op:'trace',at:{x:2,y:0}}).data;
  const f=trace();assert.equal(f.reason,'cutter_output_backed_up');
  assert.deepEqual(f.storage,[0,-1]);assert.equal(f.stock,5000);assert.deepEqual(f.upstreamOf.emptyStorage,[1,0]);
  assert.equal(f.upstreamOf.missingSlot,0);
  storage.components.ItemAcceptor.slots[0].direction='right';
  assert.equal(trace().state,'inconclusive');
});

test('pin audit returns only failed tiles and accepts a connected network with no signal',()=>{
  const {call,live}=fixture(),net={uid:97,currentValue:null},other={uid:98,currentValue:{color:'red'}};
  const nets=[net,net,other,null,{...net,valueConflict:true}];
  live.core.root.map.getLayerContentXY=x=>({components:{WiredPins:{slots:[{}, {linkedNetwork:nets[x]}]}}});
  const q={op:'check_signals',pin:1,reference:{x:0,y:0},tiles:[{x:1,y:0}]};
  assert.deepEqual(call('game',q).data,{checked:1,failed:0});
  const r=call('game',{...q,tiles:nets.map((_,x)=>({x,y:0}))}).data;
  assert.equal(r.checked,5);assert.deepEqual(r.issues.map(i=>i.reason),['wrong_network','disconnected','conflict']);
});
