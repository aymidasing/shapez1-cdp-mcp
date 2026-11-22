// Exercise the installed game engine in a separate in-memory root. This test never
// obtains the running Application or its state, save manager, storage, or HUD.
import assert from 'node:assert/strict';
import { bindRenderer } from '../dist/renderer.mjs';
import { getTarget } from '../dist/cdp.mjs';

function verify(bind) {
  const g = window.shapez;
  const app = { stateMgr: { getCurrentState: () => state } };
  const root = new g.GameRoot(app);
  const savegame = { internalId: 'isolated-engine-test' };
  const state = {app, savegame, core:{root}, stage:'s10_gameRunning', getKey:()=>'InGameState'};
  Object.assign(root, { savegame, gameState:state,
    gameMode:{getIsEditor:()=>false,getHasFreeCopyPaste:()=>false,getBlueprintShapeKey:()=>'credit',
      getIsDeterministic:()=>false},
    hubGoals:{isRewardUnlocked:()=>true,getShapesStoredByKey:()=>balance,takeShapeByKey:(_,n)=>balance-=n},
    time:{now:()=>0}, dynamicTickrate:{currentTickRate:60} });
  let balance=1000;
  root.map=new g.BaseMap(root);
  root.entityMgr=new g.EntityManager(root);
  root.logic=new g.GameLogic(root);
  root.shapeDefinitionMgr=new g.ShapeDefinitionManager(root);
  root.hud={parts:{buildingsToolbar:{buildingHandles:Object.fromEntries(
    ['belt','storage','wire','constant_signal'].map(id=>[id,{}]))},
    constantSignalEdit:{root,parseSignalCode:g.HUDConstantSignalEdit.prototype.parseSignalCode}}};
  root.systemMgr={systems:{}};
  root.systemMgr.systems.belt=new g.BeltSystem(root);
  root.systemMgr.systems.wire=new g.WireSystem(root);
  const constants=new g.ConstantSignalSystem(root);
  root.logicInitialized=true;
  root.gameInitialized=true;
  const dispatch=bind.call([app],{href:location.href,seed:'native-test',mode:'write'});
  const run=query=>{
    const result=dispatch({tool:'game',query,view:'native'});
    if(result.fault) throw Error(query.op+' '+result.fault);
    return result.data;
  };
  const p=(x,y)=>({x,y});
  run({op:'select',id:savegame.internalId});
  const route=run({op:'route',route:[p(2,2),p(6,2),p(6,5)]});
  const path=run({op:'path',at:p(2,2)});
  const wire=run({op:'wire',route:[p(2,2),p(4,2)]});
  const contact=dispatch({tool:'game',query:{op:'wire',route:[p(2,3),p(4,3)]},view:'native'}).fault;
  const constant=run({op:'place',items:[{code:31,...p(8,8)}]});
  run({op:'configure',at:p(8,8),layer:'wires',value:'red'});
  const bp=run({op:'blueprint',layer:'wires',region:{x0:8,y0:8,x1:9,y1:9}});
  const paste=run({op:'blueprint',blueprintMode:'paste',handle:bp.handle,targets:[p(10,8),p(12,8)]});
  const signal=run({op:'building',at:p(12,8),layer:'wires'}).signal;
  const removed=run({op:'remove',layer:'wires',tiles:[p(12,8)]});
  run({op:'place',items:[{code:31,x:20,y:12,rotation:90},{code:31,x:25,y:12,rotation:270}]});
  run({op:'configure',at:p(20,12),layer:'wires',value:'red'});
  run({op:'configure',at:p(25,12),layer:'wires',value:'blue'});
  const bridge={op:'wire',route:[p(21,12),p(24,12)]};
  const guarded=dispatch({tool:'game',query:bridge,view:'test'}).fault;
  run({...bridge,join:true});
  constants.update();
  root.systemMgr.systems.wire.update();
  const network=run({op:'building',at:p(22,12),layer:'wires'}).network;
  return {route,path,wire,contact,constant,paste,signal,removed,balance,guarded,network};
}

const target=await getTarget();
const socket=new WebSocket(target.socket);
try {
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  });
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Timed out waiting for isolated engine test')),15000);
    socket.addEventListener('message',({data})=>{
      const reply=JSON.parse(data);
      if(reply.id!==1) return;
      clearTimeout(timer);
      if(reply.error || reply.result.exceptionDetails) reject(Error(reply.error?.message ?? reply.result.exceptionDetails.exception?.description));
      else resolve(reply.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      expression:'('+verify.toString()+')('+bindRenderer.toString()+')',returnByValue:true}}));
  });
  console.log(JSON.stringify(result));
  assert.equal(result.route.verified,true);
  assert.equal(result.path.length,8);
  assert.deepEqual(result.path.last,[6,5]);
  assert.equal(result.wire.placed,3);
  assert.equal(result.contact,'WIRE_CONTACT');
  assert.equal(result.paste.copies,2);
  assert.equal(result.balance,1000-result.paste.spent);
  assert.equal(result.guarded,'WIRE_CONTACT');
  assert.equal(result.network.conflict,true);
  assert.equal(result.signal,'red');
  assert.equal(result.removed.removed,1);
} finally {socket.close();}
