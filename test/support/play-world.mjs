// In-memory CDP replacement for exercising the real stdio server without a running game.
import { GameConnection } from '../../dist/cdp.mjs';
import { bindRenderer } from '../../dist/renderer.mjs';

class Vector {
  constructor(x,y) { this.x=x; this.y=y; }
  addInplace(v) { this.x+=v.x; this.y+=v.y; }
}
const definitions = new Map();
const handles = {};
function define(code,id,variant='default',rv=0,layer='regular') {
  const meta = { getId:()=>id, getLayer:()=>layer, getIsUnlocked:()=>true,
    getAvailableVariants:()=>['default','second'], createEntity(args) {
      const origin = new Vector(args.origin.x,args.origin.y);
      const p = { origin, rotation:args.rotation, code: [...definitions].find(([, d]) =>
        d.metaInstance.getId() === id && d.variant === args.variant && d.rotationVariant === args.rotationVariant)[0],
        getMetaBuilding:()=>meta, getRotationVariant:()=>args.rotationVariant,
        getTileSpaceBounds:()=>({x:origin.x,y:origin.y,w:id==='storage'?2:1,h:1}) };
      const components = { StaticMapEntity:p };
      if (id==='belt') components.Belt = {};
      if (id==='wire') components.Wire = {variant:args.variant==='default'?'first':'second'};
      if (id==='constant_signal') components.ConstantSignal = {signal:null};
      const entity = {layer,components,clone() {
        const e = meta.createEntity({...args,origin});
        if (components.ConstantSignal) e.components.ConstantSignal.signal=components.ConstantSignal.signal;
        return e;
      }};
      return entity;
    }};
  definitions.set(code,{metaInstance:meta,variant,rotationVariant:rv});
  handles[id]={};
}
for(const [i,id,v,rv,l] of [[1,'belt','default',0],[2,'belt','default',1],[3,'belt','default',2],
  [21,'storage'],[27,'wire','default',0,'wires'],[52,'wire','second',0,'wires'],
  [31,'constant_signal','default',0,'wires']]) define(i,id,v,rv,l);

function fixture(id='factory-A') {
  const app={stateMgr:{getCurrentState:()=>state}};
  const savegame={internalId:id,metaDataRef:{name:'A'}};
  const state={app,savegame,getKey:()=>'InGameState',stage:'s10_gameRunning'};
  const entities=[];
  const cells=new Map();
  const key=(x,y,l)=>[x,y,l].join(',');
  function register(e) {
    e.uid=++uid;
    entities.push(e);
    const b=e.components.StaticMapEntity.getTileSpaceBounds();
    for(let x=b.x;x<b.x+b.w;x++) cells.set(key(x,b.y,e.layer),e);
  }
  let uid=0, credits=12;
  const root={app,gameState:state,savegame,entityMgr:{entities},gameMode:{
    getHasFreeCopyPaste:()=>false,getBlueprintShapeKey:()=>'credit'},
    hubGoals:{level:20,isRewardUnlocked:()=>true,takeShapeByKey:(_,n)=>credits-=n},
    hud:{parts:{buildingsToolbar:{buildingHandles:handles},constantSignalEdit:{
      parseSignalCode:(_,value)=>({getAsCopyableKey:()=>value})}}},
    map:{chunksById:new Map(),getLayerContentXY:(x,y,l)=>cells.get(key(x,y,l))},
    camera:{center:new Vector(0,0),zoomLevel:1,getVisibleRect:()=>({x:0,y:0,w:128,h:128})},
    logic:{performImmutableOperation:fn=>fn(),canDeleteBuilding:()=>true,
      checkCanPlaceEntity(e,{offset=new Vector(0,0)}={}) {
        const b=e.components.StaticMapEntity.getTileSpaceBounds();
        for(let x=b.x;x<b.x+b.w;x++) {
          const old=cells.get(key(x+offset.x,b.y+offset.y,e.layer));
          if(old && !(old.components.Belt || old.components.Wire)) return false;
        }
        return true;
      },
      tryPlaceBuilding(args) {
        const e=args.building.createEntity(args);
        if (!this.checkCanPlaceEntity(e)) return null;
        const {x,y}=e.components.StaticMapEntity.origin;
        const old=cells.get(key(x,y,e.layer));
        if(old) this.tryDeleteBuilding(old);
        register(e);
        return e;
      },
      tryDeleteBuilding(e) {
        for(const [k,v] of cells) if(v===e) cells.delete(k);
        entities.splice(entities.indexOf(e),1);
        return true;
      }}};
  for(let x=-1;x<=2;x++) for(let y=-1;y<=2;y++) root.map.chunksById.set(x+'|'+y,{
    x,y,tileX:x*16,tileY:y*16,getLowerLayerFromWorldCoords:()=>null,patches:[]});
  class Blueprint {
    constructor(entities) { this.entities=entities; }
    static fromUids(_,ids) { return new Blueprint(ids.map(id=>entities.find(e=>e.uid===id).clone())); }
    getCost(){return 5;}
    canAfford(){return credits>=5;}
    tryPlace(_,offset) {
      for(const e of this.entities){const c=e.clone();c.components.StaticMapEntity.origin.addInplace(offset);register(c);}
      return true;
    }
  }
  state.core={root};
  const href='file:///fixture';
  globalThis.location={href};
  globalThis.shapez={Vector,Blueprint,getBuildingDataFromCode:code=>definitions.get(code)};
  return bindRenderer.call([app],{href,seed:'fixture',mode:'write'});
}
let dispatch=fixture(), seed='A'.repeat(16);
let reconnect=process.env.TEST_PAGE_RECONNECT;
GameConnection.prototype.dispatch=async command=>{
  if(reconnect && command.query.cursor){
    if(reconnect==='switched')dispatch=fixture('factory-B');
    seed='B'.repeat(16);reconnect=undefined;
  }
  return {seed,response:dispatch({...command,previousConnection:!!command.connection && command.connection!==seed})};
};
