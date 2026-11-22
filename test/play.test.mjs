import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function play(run,env={}) {
  const client=new Client({name:'fixture',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[
      '--import',new URL('./support/play-world.mjs',import.meta.url).href,'dist/server.mjs'],
      env:{SHAPEZ_MODE:'write',...env}}));
    const call=async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
    const game=q=>call('game',q);
    await run(game,call);
  } finally {await client.close();}
}
const select={op:'select',id:'factory-A'};

test('selected save, all cardinal directions and corners, overwrite, bounded footprints',()=>play(async(game,call)=>{
  const route={op:'route',route:[[0,0],[2,0],[2,2]]};
  assert.equal((await game(route)).error.code,'SAVE_NOT_SELECTED');
  assert.equal((await game({...select,id:'B'})).error.code,'SAVE_ID_MISMATCH');
  await game(select);
  const steps=[[0,-1],[1,0],[0,1],[-1,0]];
  for(let i=0;i<4;i++) for(const turn of [-1,0,1]) {
    const a=steps[i], b=steps[(i+turn+4)%4];
    const result=await game({op:'route',route:[[-a[0],-a[1]],[0,0],b]});
    assert.equal(result.data.verified,true);
    const {data:{rows}}=await call('map_region',{region:[0,0,1,1]});
    assert.deepEqual(rows[0],[0,0,turn===-1?2:turn===1?3:1,i*90]);
  }
  assert.equal((await game(route)).data.placed,5);
  for(const bad of [[[0,0],[1,1]],[[0,0],[1000000000,0]],[[0,0],[1,0],[0,0]]])
    assert.ok((await game({op:'route',route:bad})).error);
  await game({op:'place',items:[{at:[8,1],code:21}]});
  assert.deepEqual((await call('map_region',{region:[9,1,10,2]})).data.rows,[[8,1,21,0]]);
  assert.equal((await game({op:'remove',tiles:[[9,1],[8,1]]})).data.removed,1);
  assert.equal((await call('map_region',{region:[0,0,33,1]})).error.code,'REGION_INVALID');
}));

test('wire contacts, separated colors, layer-specific demolition, explicit join',()=>play(async(game,call)=>{
  await game(select);
  const wire=(route,opts={})=>game({op:'wire',route,...opts});
  assert.equal((await wire([[0,0],[3,0]])).data.placed,4);
  assert.equal((await wire([[0,1],[3,1]])).error.code,'WIRE_CONTACT');
  assert.equal((await wire([[0,1],[3,1]],{color:'second'})).data.placed,4);
  assert.equal((await wire([[1,1],[1,2]],{join:true})).error.code,'CONFLICT');
  assert.equal((await wire([[3,0],[5,0]],{join:true})).data.reused,1);
  await game({op:'route',route:[[0,0],[3,0]]});
  assert.equal((await game({op:'remove',region:[0,0,4,1],layer:'wires'})).data.removed,4);
  assert.equal((await call('map_region',{region:[0,0,4,1]})).data.rows.length,4);
}));

test('native clipboard, portable settings, repeated paste, cost and blocked footprint',()=>play(async(game)=>{
  await game(select);
  await game({op:'place',items:[{at:[3,4],code:31}]});
  await game({op:'configure',at:[3,4],layer:'wires',value:'red'});
  const bp=(await game({op:'blueprint',region:[2,3,4,5],layer:'wires',portable:true})).data;
  assert.equal(bp.items[0].value,'red');
  const paste={op:'blueprint',blueprintMode:'paste',handle:bp.handle};
  assert.equal((await game({...paste,at:[2,3]})).data.reason,'CONFLICT');
  assert.equal((await game({...paste,at:[5,5]})).data.spent,5);
  const result=await game({op:'blueprint',blueprintMode:'paste',blueprint:bp.items,targets:[[8,8],[10,10]]});
  assert.deepEqual(result.data,{copies:1,spent:5,stoppedAt:[10,10],reason:'BLUEPRINT_COST'});
  assert.equal((await game({op:'building',at:[9,9],layer:'wires'})).data.signal,'red');
}));

test('preview checks current target and snapshot refuses subsequent changes',()=>play(async(game,call)=>{
  await game(select);
  const preview=()=>call('preview_belts',{region:[0,0,2,2],ops:[{op:'place_straight',tile:[0,0],to:'E'}]});
  const p=(await preview()).data.plan;
  await game({op:'route',route:[[0,0],[1,0]]});
  const apply=(plan,id)=>call('apply_belts',{plan,requestId:id});
  assert.equal((await apply(p,'test-apply-000001')).error.code,'CONFLICT');
  await game({op:'remove',tiles:[[0,0]]});
  const plan=(await preview()).data.plan;
  const id='test-apply-000002';
  const [a,b]=await Promise.all([apply(plan,id),apply(plan,id)]);
  assert.deepEqual(a,b);
  assert.equal(a.data.verified,true);
  await game({op:'route',route:[[1,0],[0,0]]});
  assert.equal((await call('restore_snapshot',{snapshot:a.data.snapshot,applyRequestId:id,requestId:'test-restore-0001'})).error.code,'RESTORE_CONFLICT');
}));

test('same keyed batch is executed once and partial batches report skipped work',()=>play(async(game,call)=>{
  await game(select);
  const requestId='batch-test-000001';
  const q={op:'place',emptyOnly:true,items:[{at:[1,1],code:21},{at:[1,1],code:21},{at:[8,2],code:21}],requestId};
  const [a,b]=await Promise.all([game(q),game(q)]);
  assert.deepEqual(a,b);assert.equal(a.data.placed,1);assert.equal(a.data.skipped,1);
  assert.equal((await call('operation_status',{requestId})).data.state,'partial');
  assert.equal((await game({...q,items:[{at:[3,4],code:21}]})).error.code,'CONFLICT');
  assert.equal((await game({op:'building',at:[8,2]})).data.found,false);
}));

for(const change of ['same','switched']){
  test('paged reconnect: '+change,()=>play(async(game,call)=>{
    await game(select);
    await game({op:'route',route:[[0,0],[2,0]]});
    const first=await call('entities',{mode:'region',region:[1,0,3,1],limit:1});
    assert.ok(first.data.next);
    const after=await call('entities',{mode:'page',cursor:first.data.next});
    if(change==='switched')assert.equal(after.error.code,'SAVE_ID_MISMATCH');
    else {
      assert.equal(after.data.restarted,true);
      assert.equal(after.data.total,2);
      assert.deepEqual(after.data.rows,first.data.rows);
      const last=await call('entities',{mode:'page',cursor:after.data.next});
      assert.equal(last.data.next,null);assert.deepEqual(last.data.rows[0].tile,{x:2,y:0});
    }
  },{TEST_PAGE_RECONNECT:change}));
}
