import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolRequest, CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CdpError, GameConnection } from './cdp.mjs';
import type { Query, ToolName } from './types.mjs';

type Contract = {
  name: ToolName;
  inputSchema: { type: 'object'; properties?: Record<string, object> };
  outputSchema: { type: 'object'; oneOf: { properties: { data?: { properties: { internalId: { const: string } } } } }[] };
};

const descriptions: Record<ToolName, [string, number]> = {
  map_region: ['完整局部地图。region=[x0,y0,x1,y1] 右下不含，最多 32×32，format=rows/image，layer=regular/wires/both。', 96],
  status: ['查看当前活动存档、关卡、世界规模、视野和可用能力。', 2],
  entities: ['查询建筑分组或冻结明细。region 为半开 tile 区间，摘要的 firstCursor 用于同一视图的分页。', 16],
  resources: ['查询资源斑块。用 color:green 或 shape:CuCuCuCu 等规范键筛选。', 12],
  sample_flow: ['在时间窗内多次采样指定区域的物流与交付进度，返回序列与增量。', 48],
  screenshot: ['截取当前存档的游戏画面与 HUD，返回 PNG 图像。窗口不可见时会失败。', 1],
  preview_belts: ['预演直带施工：返回每格前后状态与邻格影响，不改变现场，计划 60 秒有效。', 8],
  apply_belts: ['提交已预演的计划并留存快照，返回携带快照编号的回执。', 4],
  operation_status: ['按请求键查询施工或恢复回执。', 2],
  restore_snapshot: ['按快照编号与原施工请求键恢复施工前现场。', 4],
  game: ['select(id=活动档 internalId) 绑定写入；layer 切 E 视角；trace(at) 查上游堵点；check_signals(tiles,reference 或 network,pin,value) 只报异常；hub/speeds/catalog/building/path/flow 查询；place(items)/remove(tiles 或 region)/route(route)/wire(route,color,join)/blueprint(capture 或 paste)/configure/upgrade。坐标 [x,y]。', 96],
};

const mode = process.env.SHAPEZ_MODE ?? 'write';
if (mode !== 'observe' && mode !== 'write') {
  process.stderr.write('INVALID_MODE\n');
  process.exit(1);
}

const contracts: Contract[] = JSON.parse(readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'));
const game = new GameConnection(mode);
const ajv = new Ajv2020({ strict: true });
const tools = contracts.map(contract => ({
  ...contract, description: descriptions[contract.name][0],
  annotations: { readOnlyHint: !['game','apply_belts','restore_snapshot'].includes(contract.name), openWorldHint: false },
}));
const validators = new Map(tools.map(tool => [tool.name, {
  input: ajv.compile<Query>(tool.inputSchema),
  output: ajv.compile(tool.outputSchema),
}]));

type PlanState = { epoch: string; before: any[]; ops: any[]; createdAt: number };
type SnapshotState = { epoch: string; after: any[]; id: string; applyRequestId: string; tiles: any[] };
type ReceiptState = {
  requestId: string;
  action: 'apply' | 'restore' | 'game'; result?: Record<string,unknown>;
  state: 'prepared' | 'executing' | 'applied' | 'restored' | 'partial' | 'unknown' | 'aborted';
  snapshot: string | null;
  completed: number | null;
  verified: boolean;
};

const plans = new Map<string, PlanState>();
const snapshots = new Map<string, SnapshotState>();
const requestTargets = new Map<string,string>();
const receipts = new Map<string, ReceiptState>();
const planTtlMs = 60_000;
const newToken = () => randomBytes(12).toString('base64url');

const faults: Record<string, [string, string]> = {
  SIGNAL_REFERENCE_INVALID: ['参考引脚未接线或有信号冲突','检查参考坐标、图层和 referencePin'],
  CDP_TIMEOUT: ['游戏渲染进程未在时限内应答', '查询可以重试；写入结果需要先核对现场或原请求回执'],
  CDP_UNREACHABLE: ['无法连接本机游戏调试端口', '确认现有游戏进程仍在运行且 9222 可用，再调用 status'],
  TARGET_INVALID: ['未发现唯一可信的游戏页面', '核对当前 shapez 1.5.6 的现有调试端口'],
  NOT_IN_GAME: ['游戏处于菜单或加载阶段', '请在游戏中进入存档，再调用 status'],
  IDENTITY_UNKNOWN: ['无法确认活动状态、存档和游戏世界的归属', '等待存档完成加载，再调用 status'],
  SAVE_ID_MISMATCH: ['存档绑定校验失败', '重新调用 status 确认当前活动存档'],
  SESSION_CHANGED: ['活动会话已失效', '重新调用 status，并从查询首页开始'],
  REGION_INVALID: ['区域面积、尺寸或测点位置超出允许范围', '检查半开区间的 tile 坐标及该工具的区域上限'],
  REGION_OUT_OF_BOUNDS: ['区域与未加载的地图块相交', '缩小或重选已加载区域'],
  CURSOR_INVALID: ['游标无效、已过期或不属于该查询', '重新请求摘要或首页'],
  OUTPUT_LIMIT: ['结果超出视图或返回大小预算', '缩小区域，或使用资源键和建筑类型过滤'],
  CAPABILITY_UNVERIFIED: ['当前游戏适配未验证该能力', '查看 status 中的 capabilities，使用已验证的查询'],
  CAPTURE_FAILED: ['无法取得可显示的游戏帧', '恢复游戏窗口，等待画面显示后再调用 screenshot'],
  BUSY: ['另一截图或调试操作正在进行', '等待当前操作结束后再取图'],
  ARGUMENT_INVALID: ['操作参数无效', '检查当前操作的必填字段、方向和图层'],
  SAVE_NOT_SELECTED: ['尚未绑定这个活动世界', '调用 status 核对，然后 game select 传入该档 internalId'],
  WIRE_CONTACT: ['线路会接触已有电线、隧道或意外引脚', '查看局部线路，改道或用 join:true 显式接网'],
  BUILDING_LOCKED: ['建筑或变体在当前模式不可用', '查看 catalog 和关卡解锁状态'],
  BLUEPRINT_INVALID: ['蓝图无效、为空或已失效', '在当前存档重新 capture'],
  BLUEPRINT_COST: ['蓝图点数不足', '先交付蓝图图形，或缩小复制区域'],
  READ_ONLY: ['服务处于只读模式', '可通过 status、entities 和 resources 查询活动世界'],
  REQUEST_UNKNOWN: ['未找到该请求的操作回执', '核对原始请求键'],
  SAMPLE_INTERRUPTED: ['采样期间现场发生变化', '重新采样并确认关卡与目标未变'],
  PLAN_STALE: ['预演计划已过期或已被使用', '重新调用 preview_belts 生成新计划'],
  CONFLICT: ['目标格状态与操作不符', '重新预演确认占用情况'],
  SNAPSHOT_FAILED: ['快照不存在或与施工请求不匹配', '核对快照编号与原施工请求键'],
  PARTIAL_WRITE: ['只有部分动作完成', '用 operation_status 追查后按需恢复'],
  OUTCOME_UNKNOWN: ['无法确认施工结果', '用 operation_status 或现场查询确认'],
  RESTORE_CONFLICT: ['施工现场之后又有改动', '重新确认现场后再决定是否恢复'],
};

const secret = randomBytes(32);
const sign = (name: ToolName, value: string) =>
  createHmac('sha256', secret).update(name + ':' + value).digest().subarray(0, 16);
const cursorPattern = /^([\w-]{16})(\d{1,8})_([\w-]{22})_(\d{1,7})_([\w-]{22})$/;

function encode(name: ToolName, seed: string, view: string, offset: number) {
  const value = seed + view + '_' + offset;
  return value + '_' + sign(name, value).toString('base64url');
}

function decode(name: ToolName, cursor?: string) {
  const match = cursor?.match(cursorPattern);
  if (!match) return {};
  const [, seed, generation, viewId, offset, signature] = match;
  const expected = sign(name, cursor!.slice(0, -23)).toString('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return {};
  return { connection: seed, position: { view: generation + '_' + viewId, offset: Number(offset) } };
}

function fault(code: string, inGame: boolean | null, query: Query) {
  const [message, hint] = faults[code] ?? faults.CAPABILITY_UNVERIFIED;
  return {
    error: {
      code: faults[code] ? code : 'CAPABILITY_UNVERIFIED', message, hint, inGame,
      requestId: query.requestId ?? null, snapshot: null,
    },
  };
}

function present(payload: ReturnType<typeof fault> | { data: Record<string, unknown> }) {
  return {
    ...('error' in payload ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const server = new Server({ name: 'shapez1-cdp-agent', version: '0.1.0' }, { capabilities: { tools: {} } });
// Detailed output contracts are validated locally. Keep tool discovery inexpensive.
const publicTools = tools.map(({ outputSchema: _output, ...tool }) => ({ ...tool,
  outputSchema: { type: 'object' as const, properties: { data: { type: 'object' }, error: { type: 'object' } } },
}));
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: publicTools }));
async function sampleFlow(query: Query): Promise<ReturnType<typeof fault> | { data: Record<string, unknown> }> {
  const seconds = Math.min(Math.max(Number(query.seconds ?? 5), 2), 20);
  const samples = Math.min(Math.max(Number(query.samples ?? 5), 3), 12);
  const interval = Math.max(1, Math.floor((seconds * 1000) / (samples - 1)));
  const series: Record<string, unknown>[] = [];
  for (let index = 0; index < samples; index++) {
    try {
      const { response } = await game.dispatch({
        tool: 'game', query: { op: 'sample', region: query.region, points: query.points }, view: 'sample',
      });
      if (!response.data) return fault(response.fault ?? 'CAPABILITY_UNVERIFIED', response.inGame ?? null, query);
      const firstSample = series[0];
      if (firstSample && ['epoch','level','goal'].some(key => firstSample[key] !== response.data![key])) {
        return fault('SAMPLE_INTERRUPTED', true, query);
      }
      series.push({ index, ...response.data });
    } catch (error) {
      return fault(error instanceof CdpError ? error.code : 'CDP_UNREACHABLE', null, query);
    }
    if (index < samples - 1) await new Promise(resolve => setTimeout(resolve, interval));
  }
  const first = series[0] as { delivered?: number; flow?: { total?: number } };
  const last = series[series.length - 1] as { delivered?: number; flow?: { total?: number } };
  const deliveredFirst = typeof first.delivered === 'number' ? first.delivered : null;
  const deliveredLast = typeof last.delivered === 'number' ? last.delivered : null;
  const rateGoal = series[0].throughputOnly === true;
  const delta = !rateGoal && deliveredFirst !== null && deliveredLast !== null ? deliveredLast - deliveredFirst : null;
  return {
    data: {
      seconds, samples: series.length, reportedSamples: samples,
      deliveredStart: deliveredFirst, deliveredEnd: deliveredLast, deliveredDelta: delta,
      throughputPerSecond: rateGoal ? deliveredLast : delta === null ? null : Number((delta / Math.max(0.001, (Number(series.at(-1)!.at) - Number(series[0].at)) / 1000)).toFixed(3)),
      flowStart: first.flow?.total ?? null, flowEnd: last.flow?.total ?? null,
      series,
    },
  };
}

function normalizeQuery(input: any): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const query: any = { ...input };
  for (const key of ['region', 'items', 'tiles', 'ops', 'blueprint', 'snapshotTiles', 'points']) {
    if (typeof query[key] === 'string') {
      const trimmed = query[key].trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { query[key] = JSON.parse(trimmed); } catch { /* keep original */ }
      }
    }
  }
  const point = (p: any) => Array.isArray(p) && p.length === 2 ? { x: p[0], y: p[1] } : p;
  if (Array.isArray(query.region) && query.region.length === 4) {
    const [x0, y0, x1, y1] = query.region;
    query.region = { x0, y0, x1, y1 };
  }
  if (query.at) query.at = point(query.at);
  if (query.reference) query.reference = point(query.reference);
  for (const key of ['route','points','tiles','targets']) {
    if (Array.isArray(query[key])) query[key] = query[key].map(point);
  }
  if (Array.isArray(query.ops)) query.ops = query.ops.map((op: any) => op && ({ ...op, tile: point(op.tile) }));
  if (Array.isArray(query.items)) query.items = query.items.map((item: any) => {
    if (!item || typeof item !== 'object' || !item.at) return item;
    if ('x' in item || 'y' in item) throw new McpError(ErrorCode.InvalidParams, 'Use either at or x/y for one item');
    const { at, ...rest } = item;
    return { ...rest, ...point(at) };
  });
  return query;
}

const unresolvedPlans=new Map<string,PlanState>();
function applyReceipt(requestId:string,state:PlanState,data:Record<string,unknown>):ReceiptState{
  const snapshotId=newToken();
  snapshots.set(snapshotId,{id:snapshotId,epoch:state.epoch,after:data.after as any[],applyRequestId:requestId,tiles:state.before});
  const verified=data.verified===true;
  return {requestId,action:'apply',state:verified?'applied':'partial',snapshot:snapshotId,completed:Number(data.completed ?? 0),verified};
}
async function reconcile(r:ReceiptState){
  if(r.state!=='unknown')return r;
  const recovered=await game.recover(r.requestId);
  const result=recovered?.data;
  if(!result){
    if(recovered?.saveId && recovered.fault && recovered.fault!=='OUTCOME_UNKNOWN'){
      r.state='aborted'; r.result={reason:recovered.fault}; unresolvedPlans.delete(r.requestId);
    }
    return r;
  }
  if(r.action==='game')finishGameReceipt(r,result);
  if(r.action==='apply'){
    const plan=unresolvedPlans.get(r.requestId);
    if(plan){Object.assign(r,applyReceipt(r.requestId,plan,result));unresolvedPlans.delete(r.requestId);}
  }
  if(r.action==='restore'){
    r.verified=Number(result.restored)===snapshots.get(r.snapshot!)?.tiles.length;
    r.state=r.verified?'restored':'partial';
  }
  return r;
}
const viewQueries=new Map<string,{query:Query;saveId:string}>();
function gameplayWrite(q:Query){
  return ['place','remove','route','wire','configure','upgrade','save','view'].includes(q.op ?? '') ||
    (q.op==='layer' && !!q.layer) || (q.op==='blueprint' && q.blueprintMode==='paste');
}
function fingerprint(q:Query){
  const canonical=JSON.stringify(q,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
  return 'game/'+createHash('sha256').update(canonical).digest('hex');
}
function finishGameReceipt(r:ReceiptState,data:Record<string,unknown>){
  r.state=data.reason || data.verified===false || Number(data.protected)>0 ? 'partial' : 'applied';
  r.completed=Number(data.placed ?? data.removed ?? data.copies ?? 1);
  r.verified=data.verified===true;
  r.result=data;
}
async function mutate(q:Query){
  const requestId=q.requestId ?? newToken(), target=fingerprint(q);
  const old=receipts.get(requestId);
  if(old){
    if(requestTargets.get(requestId)!==target)return fault('CONFLICT',true,q);
    await reconcile(old);
    if(old.state==='aborted')return fault(String(old.result?.reason),true,q);
    return old.result ? {data:{...old.result,requestId}} : fault('OUTCOME_UNKNOWN',null,{...q,requestId});
  }
  const r:ReceiptState={requestId,action:'game',state:'unknown',completed:null,snapshot:null,verified:false};
  try{
    const {response}=await game.dispatch({tool:'game',query:{...q,requestId},view:'write'});
    if(!response.data)return fault(response.fault ?? 'CAPABILITY_UNVERIFIED',response.inGame ?? null,{...q,requestId});
    finishGameReceipt(r,response.data);
    if(q.requestId){receipts.set(requestId,r);requestTargets.set(requestId,target);}
    return {data:q.requestId?{...response.data,requestId}:response.data};
  }catch(error){
    const code=error instanceof CdpError?error.code:'CDP_UNREACHABLE';
    if(code==='OUTCOME_UNKNOWN'){receipts.set(requestId,r);requestTargets.set(requestId,target);}
    return fault(code,null,{...q,requestId});
  }
}

async function handle({ params }: CallToolRequest) {
  const name = params.name as ToolName;
  const validation = validators.get(name);
  if (!validation) throw new McpError(ErrorCode.InvalidParams, 'Unknown shapez1 tool');
  const query = normalizeQuery(params.arguments ?? {});
  if (!validation.input(query)) {
    const detail = JSON.stringify(validation.input.errors ?? []).slice(0, 400);
    throw new McpError(ErrorCode.InvalidParams,
      'Arguments do not match the tool input schema: ' + detail + ' :: ' + JSON.stringify(query).slice(0, 300));
  }
  let payload: ReturnType<typeof fault> | { data: Record<string, unknown> };
  let png: string | undefined;
  if(name==='game' && gameplayWrite(query)) {
    payload=await mutate(query);
  } else if (name === 'preview_belts') {
    if (mode === 'observe') {
      payload = fault('READ_ONLY', true, query);
    } else {
      try {
        const { response } = await game.dispatch({
          tool: 'game', query: { op: 'preview', region: query.region, ops: query.ops }, view: 'preview',
        });
        if (!response.data) {
          payload = fault(response.fault ?? 'CAPABILITY_UNVERIFIED', response.inGame ?? null, query);
        } else {
          const epoch = String((response.data as any).epoch ?? '');
          const plan = newToken();
          plans.set(plan, {
            epoch,
            before: (response.data as any).before ?? [],
            ops: query.ops ?? [],
            createdAt: Date.now(),
          });
          payload = { data: { plan, epoch, validForSeconds: 60, cells: (response.data as any).cells ?? [] } };
        }
      } catch (error) {
        payload = fault(error instanceof CdpError ? error.code : 'CDP_UNREACHABLE', null, query);
      }
    }
  } else if (name === 'apply_belts') {
    const planToken = String(query.plan ?? '');
    const requestId = String(query.requestId ?? '');
    const state = plans.get(planToken);
    if (mode === 'observe') {
      payload = fault('READ_ONLY', true, query);
    } else if (receipts.has(requestId)) {
      payload = requestTargets.get(requestId) === 'apply/' + planToken ? {data:await reconcile(receipts.get(requestId)!)} : fault('CONFLICT',true,query);
    } else if (!state || Date.now() - state.createdAt > planTtlMs) {
      payload = fault('PLAN_STALE', true, query);
    } else {
      try {
        const { response } = await game.dispatch({
          tool: 'game', query: { op: 'applyBelts', requestId, ops: state.ops, epoch: state.epoch, snapshotTiles: state.before }, view: 'apply',
        });
        if (!response.data) {
          payload = fault(response.fault ?? 'CAPABILITY_UNVERIFIED', response.inGame ?? null, query);
        } else {
          const receipt=applyReceipt(requestId,state,response.data);
          requestTargets.set(requestId,'apply/' + planToken);
          receipts.set(requestId, receipt);
          plans.delete(planToken);
          payload = { data: receipt };
        }
      } catch (error) {
        if (error instanceof CdpError && error.code === 'OUTCOME_UNKNOWN') {
          plans.delete(planToken);
          unresolvedPlans.set(requestId,state);
          requestTargets.set(requestId,'apply/' + planToken);
          receipts.set(requestId,{requestId,action:'apply',state:'unknown',snapshot:null,completed:null,verified:false});
        }
        payload = fault(error instanceof CdpError ? error.code : 'CDP_UNREACHABLE', null, query);
      }
    }
  } else if (name === 'operation_status') {
    const receipt = receipts.get(String(query.requestId ?? ''));
    if(receipt)await reconcile(receipt);
    payload = receipt ? { data: receipt } : fault('REQUEST_UNKNOWN', true, query);
  } else if (name === 'restore_snapshot') {
    const snapshotId = String(query.snapshot ?? '');
    const applyRequestId = String(query.applyRequestId ?? '');
    const requestId = String(query.requestId ?? '');
    const snapshot = snapshots.get(snapshotId);
    const applied = receipts.get(applyRequestId);
    if (mode === 'observe') {
      payload = fault('READ_ONLY', true, query);
    } else if (!snapshot || !applied || snapshot.applyRequestId !== applyRequestId) {
      payload = fault('SNAPSHOT_FAILED', true, query);
    } else if (receipts.has(requestId)) {
      payload = requestTargets.get(requestId) === 'restore/' + snapshotId ? {data:await reconcile(receipts.get(requestId)!)} : fault('CONFLICT',true,query);
    } else {
      try {
        const { response } = await game.dispatch({
          tool: 'game', query: { op: 'restoreTiles', requestId, epoch: snapshot.epoch, snapshotTiles: snapshot.tiles, expected: snapshot.after }, view: 'restore',
        });
        if (!response.data) {
          payload = fault(response.fault ?? 'CAPABILITY_UNVERIFIED', response.inGame ?? null, query);
        } else {
          const restored = Number((response.data as any).restored ?? 0);
          const receipt: ReceiptState = {
            requestId, action: 'restore', state: restored === snapshot.tiles.length ? 'restored' : 'partial',
            snapshot: snapshotId, completed: null, verified: restored === snapshot.tiles.length,
          };
          requestTargets.set(requestId,'restore/' + snapshotId);
          receipts.set(requestId, receipt);
          payload = { data: receipt };
        }
      } catch (error) {
        if (error instanceof CdpError && error.code === 'OUTCOME_UNKNOWN') {
          requestTargets.set(requestId,'restore/' + snapshotId);
          receipts.set(requestId,{requestId,action:'restore',state:'unknown',snapshot:snapshotId,completed:null,verified:false});
        }
        payload = fault(error instanceof CdpError ? error.code : 'CDP_UNREACHABLE', null, query);
      }
    }
  } else if (name === 'sample_flow') {
    payload = await sampleFlow(query);
  } else {
    try {
      const cursor=decode(name,query.cursor);
      const source=cursor.position && viewQueries.get(cursor.connection+'/'+cursor.position.view);
      const view=randomBytes(16).toString('base64url');
      let {response,seed}=await game.dispatch({tool:name,query,view,...cursor,saveId:source?.saveId});
      let original=source?.query ?? query;
      if((response.fault==='SESSION_CHANGED' || response.fault==='CURSOR_INVALID') && source){
        original={...source.query,mode:'page'};
        ({response,seed}=await game.dispatch({tool:name,query:original,view,saveId:source.saveId}));
        if(response.data)response.data.restarted=true;
      }
      if (response.data) {
        if (response.position) {
          const key=seed+'/'+response.position.view;
          if(response.saveId && !viewQueries.has(key)){
            viewQueries.set(key,{query:original,saveId:response.saveId});
            if(viewQueries.size>128)viewQueries.delete(viewQueries.keys().next().value!);
          }
          response.data[query.mode === 'summary' ? 'firstCursor' : 'next'] =
            encode(name, seed, response.position.view, response.position.offset);
        }
        payload = { data: response.data };
        if (name === 'screenshot' || name === 'map_region') png = response.image;
      } else {
        payload = fault(response.fault ?? 'CAPABILITY_UNVERIFIED', response.inGame ?? null, query);
      }
    } catch (error) {
      payload = fault(error instanceof CdpError ? error.code : 'CDP_UNREACHABLE', null, query);
    }
  }
  if (!validation.output(payload)) payload = fault('CAPABILITY_UNVERIFIED', 'data' in payload ? true : null, query);
  const budget = descriptions[name][1] * 1024;
  const result = present(payload);
  if ((name === 'screenshot' || (name === 'map_region' && query.format === 'image')) && 'data' in payload) {
    if (!png || png.length > 4 * Math.ceil(512 * 1024 / 3) ||
        Buffer.from(png, 'base64').length !== payload.data.bytes) return present(fault('CAPTURE_FAILED', true, query));
    const withImage = { ...result, content: [...result.content, { type: 'image' as const, mimeType: 'image/png', data: png }] };
    return Buffer.byteLength(JSON.stringify(withImage)) <= 700 * 1024 ? withImage : present(fault('OUTPUT_LIMIT', true, query));
  }
  if (Buffer.byteLength(result.content[0].text) > budget ||
      Buffer.byteLength(JSON.stringify(result)) > ('error' in payload ? 2048 : 4 * budget + 1024)) {
    return present(fault('OUTPUT_LIMIT', true, query));
  }
  return result;
}

// Serialize receipt lookup, dispatch and recording for concurrent submissions.
let pending = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, request => {
  const {name,arguments:args}=request.params;
  const q=(args ?? {}) as Query;
  const ordered=['apply_belts','restore_snapshot','operation_status'].includes(name) ||
    (name==='game' && (q.op==='select' || gameplayWrite(q)));
  if(!ordered)return handle(request);
  const work = pending.then(() => handle(request));
  pending = work.then(() => {}, () => {});
  return work;
});

const transport = new StdioServerTransport();
process.stdin.once('end', () => game.close());
process.once('SIGINT', () => { game.close(); void server.close(); });
process.once('SIGTERM', () => { game.close(); void server.close(); });
try {
  await server.connect(transport);
} catch {
  process.stderr.write('MCP_START_FAILED\n');
  process.exitCode = 1;
}
