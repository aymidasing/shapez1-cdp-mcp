import type { Command, Mode, Point, Query, QueryTool, Region, Result } from './types.mjs';

type Chunk = {
  x: number; y: number; tileX: number; tileY: number;
  patches: { item: Item; pos: Point; size: number }[];
};
type Item = { getItemType?(): string; definition?: { getHash?(): string }; color?: string };
type Components = Record<string, unknown> & {
  StaticMapEntity?: { origin: Point; rotation: number; getRotationVariant(): number };
};
type GameRoot = {
  app: App; savegame: object; gameState: State;
  camera: { center: Point; zoomLevel: number; getVisibleRect(): { x: number; y: number; w: number; h: number } };
  hubGoals: { level: number; [key: string]: any };
  logic: any;
  entityMgr: { entities: { components: Components; layer: string }[] };
  map: { chunksById: Map<string, Chunk> };
};
type State = {
  getKey?(): string;
  stage?: string;
  app: App;
  core?: { root: GameRoot };
  savegame?: { internalId: string };
};
type App = { stateMgr?: { getCurrentState?(): State } };
type Settings = { href: string; seed: string; mode: Mode };
type View = {
  tool: QueryTool; expires: number; limit: number;
  timer?: ReturnType<typeof setTimeout>;
  count: number; index: Uint32Array;
  row(n: number): Record<string, unknown>;
  summarize(): Record<string, unknown>;
};

// CDP serializes this function. It has no dependencies outside its own scope.
export function bindRenderer(this: App[], settings: Settings) {
  function samePage() {
    return globalThis.top === globalThis.self && location.href === settings.href;
  }
  if (!samePage()) return null;

  function current(app: App) {
    const state = app.stateMgr?.getCurrentState?.();
    return state?.app === app ? state : undefined;
  }
  const candidates = this.filter(app => current(app));
  if (candidates.length !== 1) return null;

  return dispatcher(new WeakRef(candidates[0]));

  function dispatcher(application: WeakRef<App>) {
    const chunkSize = 16;
    const tileSize = 32;
    const maxViewBytes = 8 * 1024 * 1024;
    const encoder = new TextEncoder();
    const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
    const views = new Map<string, View>();
    const weakViews = new WeakRef(views);
    let previous: [WeakRef<State>, WeakRef<object>, WeakRef<GameRoot>] | undefined;
    let generation = 0;
    let selected = false;
    const clipboards = new Map<string, { blueprint: any; anchor: Point }>();
    let clipboardId = 0;
    const engine = () => (globalThis as any).shapez;
    const vec = (x: number, y: number) => new (engine().Vector)(x, y);
    const epoch = () => settings.seed + '_' + generation;

    function fail(code: string, inGame: boolean | null = true): never {
      throw { fault: code, inGame };
    }
    function clearSession() {
      if (previous) generation++;
      selected = false;
      clipboards.clear();
      previous = undefined;
      for (const key of views.keys()) evict(key);
    }
    function evict(key: string) {
      clearTimeout(views.get(key)?.timer);
      views.delete(key);
    }
    function activeGame() {
      if (!samePage()) fail('SESSION_CHANGED', null);
      const app = application.deref();
      const state = app && current(app);
      const key = state?.getKey?.();
      if (!state || !key) fail('IDENTITY_UNKNOWN', null);
      if (key !== 'InGameState' || state.stage !== 's10_gameRunning') fail('NOT_IN_GAME', false);
      const save = state.savegame;
      if (!save || typeof save.internalId !== 'string') fail('IDENTITY_UNKNOWN');
      const root = state.core?.root;
      if (!root || root.gameState !== state || root.savegame !== save || root.app !== app) {
        fail('IDENTITY_UNKNOWN');
      }
      if (previous?.[0].deref() !== state || previous[1].deref() !== save || previous[2].deref() !== root) {
        clearSession();
        previous = [new WeakRef(state), new WeakRef(save), new WeakRef(root)];
      }
      return root;
    }

    function contains(region: Region | undefined, x: number, y: number) {
      return !region || (region.x0 <= x && x < region.x1 && region.y0 <= y && y < region.y1);
    }
    function isInt32(value: number) {
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    }
    function checkRegion(root: GameRoot, region: Region | undefined, max: number) {
      if (!region) return;
      const { x0, y0, x1, y1 } = region;
      if (![x0,y0,x1,y1].every(isInt32) || x1 <= x0 || y1 <= y0 || x1 - x0 > max || y1 - y0 > max) fail('REGION_INVALID');
      for (let y = Math.floor(y0 / chunkSize); y <= Math.floor((y1 - 1) / chunkSize); y++) {
        for (let x = Math.floor(x0 / chunkSize); x <= Math.floor((x1 - 1) / chunkSize); x++) {
          const chunk = root.map.chunksById.get(x + '|' + y);
          if (!chunk) fail('REGION_OUT_OF_BOUNDS');
          if (chunk.tileX !== x * chunkSize || chunk.tileY !== y * chunkSize) fail('CAPABILITY_UNVERIFIED');
        }
      }
    }

    function status(root: GameRoot) {
      const { x, y, w, h } = root.camera.getVisibleRect();
      const { center, zoomLevel } = root.camera;
      const save = root.savegame as { internalId?: string };
      if (!save || typeof save.internalId !== 'string') fail('IDENTITY_UNKNOWN');
      return {
        inGame: true, internalId: save.internalId, name: String((save as any).metaDataRef?.name || '当前存档').slice(0,32),
        epoch: epoch(), selected, layer: (root as any).currentLayer ?? 'regular', mode: settings.mode, capabilities: ['screenshot','map_region','flow','trace','check_signals','catalog','blueprint_capture',
          ...(settings.mode === 'write' ? ['place','remove','route','wire','blueprint_paste','configure','upgrade','preview','apply','restore'] : [])],
        level: root.hubGoals.level, entityCount: root.entityMgr.entities.length,
        loadedChunks: root.map.chunksById.size,
        camera: {
          centerWorld: { x: center.x, y: center.y }, zoom: zoomLevel,
          visibleWorld: { x0: x, y0: y, x1: x + w, y1: y + h },
          visibleTiles: {
            x0: Math.floor(x / tileSize), y0: Math.floor(y / tileSize),
            x1: Math.ceil((x + w) / tileSize), y1: Math.ceil((y + h) / tileSize),
          },
        },
      };
    }

    function classify(components: Components) {
      const has = (key: string) => Object.prototype.hasOwnProperty.call(components, key);
      if (has('Hub')) return ['hub', 'Hub'] as const;
      if (has('UndergroundBelt')) return ['underground', 'UndergroundBelt'] as const;
      if (has('Belt')) return ['belt', 'Belt'] as const;
      if (has('ItemProcessor') && has('ItemAcceptor') && has('ItemEjector')) {
        return ['processor', 'ItemAcceptor,ItemEjector,ItemProcessor'] as const;
      }
      if (has('Miner')) return ['miner', 'ItemEjector'] as const;
      if (has('ItemEjector')) return ['ejector', 'ItemEjector'] as const;
      return ['unknown', 'Unknown'] as const;
    }

    function patchKey(item: Item) {
      const kind = item?.getItemType?.();
      const value = kind === 'shape' ? item.definition?.getHash?.() : item?.color;
      if ((kind === 'shape' || kind === 'color') && typeof value === 'string' &&
          value.length > 0 && kind.length + 1 + value.length <= 128) {
        return [kind, kind + ':' + value];
      }
      return ['unknown', 'unknown'];
    }

    function freeze(root: GameRoot, tool: QueryTool, query: Query): View {
      checkRegion(root, query.region, 512);
      const entities = tool === 'entities';
      const stride = 7;
      const blockRows = 2048;
      const groups = new Map<string, number>();
      const dictionary = new Map<string, number>();
      const strings: string[] = [];
      const blocks: (Int32Array | Float64Array)[] = [];
      let count = 0;
      let storage = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

      function reserve(size: number) {
        storage += size;
        if (storage > maxViewBytes) fail('OUTPUT_LIMIT');
      }
      function intern(value: string) {
        const existing = dictionary.get(value);
        if (existing !== undefined) return existing;
        reserve(128 + value.length * 2);
        dictionary.set(value, strings.length);
        return strings.push(value) - 1;
      }
      function append(x: number, y: number, a: number, b: number, c: number, kind: string, label: string, group: string) {
        const blockIndex = Math.floor(count / blockRows);
        if (blockIndex === blocks.length) {
          reserve(blockRows * stride * (entities ? 4 : 8));
          blocks.push(entities ? new Int32Array(blockRows * stride) : new Float64Array(blockRows * stride));
        }
        reserve(4);
        blocks[blockIndex].set([x, y, a, b, c, intern(kind), intern(label)], (count % blockRows) * stride);
        count++;
        const old = groups.get(group);
        if (old === undefined) reserve(128 + group.length * 2);
        groups.set(group, (old ?? 0) + 1);
        x0 = Math.min(x0, Math.floor(x));
        y0 = Math.min(y0, Math.floor(y));
        x1 = Math.max(x1, Math.floor(x) + 1);
        y1 = Math.max(y1, Math.floor(y) + 1);
      }

      if (entities) {
        const source = query.region && (root.map as any).getLayerContentXY
          ? regionEntities(root,query.region,['regular','wires']) : root.entityMgr.entities;
        for (const { components, layer } of source) {
          const position = components.StaticMapEntity;
          if (!position) fail('CAPABILITY_UNVERIFIED');
          const { x, y } = position.origin;
          if (!contains(query.region, x, y)) continue;
          const [kind, group] = classify(components);
          if (query.kind && query.kind !== kind) continue;
          const variant = position.getRotationVariant();
          if (![x, y, position.rotation, variant].every(isInt32)) fail('CAPABILITY_UNVERIFIED');
          const signature = Object.keys(components).sort().join(',') || 'Unknown';
          const label = signature.length <= 192 ? signature : signature.slice(0, 189) + '...';
          append(x, y, layer === 'wires' ? 1 : 0, position.rotation, variant, kind, label, group);
        }
      } else {
        for (const chunk of root.map.chunksById.values()) {
          if (chunk.tileX !== chunk.x * chunkSize || chunk.tileY !== chunk.y * chunkSize) fail('CAPABILITY_UNVERIFIED');
          for (const patch of chunk.patches) {
            if (!contains({ x0: 0, y0: 0, x1: chunkSize, y1: chunkSize }, patch.pos.x, patch.pos.y) ||
                !Number.isFinite(patch.size) || patch.size < 0) fail('CAPABILITY_UNVERIFIED');
            const x = chunk.tileX + patch.pos.x;
            const y = chunk.tileY + patch.pos.y;
            if (!contains(query.region, x, y)) continue;
            const [kind, key] = patchKey(patch.item);
            if ((query.kind && query.kind !== kind) || (query.key && query.key !== key)) continue;
            append(x, y, chunk.x, chunk.y, patch.size, kind, key, key);
          }
        }
      }

      const index = new Uint32Array(count);
      for (let i = 0; i < count; i++) index[i] = i;
      const get = (row: number, col: number) => blocks[Math.floor(row / blockRows)][(row % blockRows) * stride + col];
      index.sort((a, b) => get(a, 1) - get(b, 1) || get(a, 0) - get(b, 0) ||
        (entities ? get(a, 2) - get(b, 2) : get(a, 3) - get(b, 3) || get(a, 2) - get(b, 2)) || a - b);
      const sortedGroups = [...groups].sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : Number(a > b)));
      const top = sortedGroups.slice(0, 24).map(([key, count]) => ({ key, count }));
      const bbox = count ? { x0, y0, x1, y1 } : null;

      return {
        tool, expires: Date.now() + 120_000, limit: query.limit ?? 24, count, index,
        summarize: () => ({ total: count, groups: top, other: count - top.reduce((sum, group) => sum + group.count, 0), bbox }),
        row(row) {
          const [x, y, a, b, c, kind, label] = blocks[Math.floor(row / blockRows)]
            .subarray((row % blockRows) * stride, (row % blockRows) * stride + stride);
          return entities
            ? { row, tile: { x, y }, kind: strings[kind], signature: strings[label], rotation: b, rotationVariant: c, ports: null }
            : { row, chunk: { x: a, y: b }, centerTile: { x, y }, kind: strings[kind], key: strings[label], size: c };
        },
      };
    }

    function observations(root: GameRoot, command: Command & { tool: QueryTool }): Result {
      const { query, tool } = command;
      const now = Date.now();
      for (const [key, view] of views) if (view.expires <= now) evict(key);
      if (command.previousConnection) fail('SESSION_CHANGED');
      const follow = query.cursor !== undefined;
      if (follow && !command.position) fail('CURSOR_INVALID');
      const prefix = generation + '_';
      const key = command.position?.view ?? prefix + command.view;
      if (follow && !key.startsWith(prefix)) fail('SESSION_CHANGED');
      const offset = command.position?.offset ?? 0;
      let view = views.get(key);
      if (follow) {
        if (!view || view.tool !== tool || offset >= view.count) fail('CURSOR_INVALID');
      } else {
        view = freeze(root, tool, query);
        if (view.count) {
          if (views.size >= 4) evict(views.keys().next().value!);
          views.set(key, view);
          view.timer = scheduleExpiration(weakViews, key);
        }
      }
      if (query.mode === 'summary') {
        return {
          data: { mode: 'summary', view: key, ...view.summarize(), firstCursor: null },
          position: view.count ? { view: key, offset: 0 } : undefined,
        };
      }
      const rows: Record<string, unknown>[] = [];
      const data = { mode: query.mode, view: key, total: view.count, rows, next: null };
      // Reserve the maximum encoded cursor length before Node signs the next offset.
      let remaining = (tool === 'entities' ? 16 : 12) * 1024 -
        bytes({ data: { ...data, next: 'x'.repeat(96) } });
      for (let i = offset; i < view.count && rows.length < view.limit; i++) {
        const row = view.row(view.index[i]);
        remaining -= bytes(row) + (rows.length ? 1 : 0);
        if (remaining < 0) {
          if (!rows.length) fail('OUTPUT_LIMIT');
          break;
        }
        rows.push(row);
      }
      const nextOffset = offset + rows.length;
      return { data, position: nextOffset < view.count ? { view: key, offset: nextOffset } : undefined };
    }

    function scheduleExpiration(cache: WeakRef<Map<string, View>>, key: string) {
      // Retain no view or application through the timer after a CDP disconnect.
      return setTimeout(() => cache.deref()?.delete(key), 120_000);
    }

    function jsonSafe(value: unknown, depth = 4): unknown {
      if (depth < 0) return null;
      if (value === null) return null;
      const kind = typeof value;
      if (kind === 'number') return Number.isFinite(value as number) ? value : null;
      if (kind === 'string' || kind === 'boolean') return value;
      if (Array.isArray(value)) return value.slice(0, 64).map(entry => jsonSafe(entry, depth - 1));
      if (kind === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as object).slice(0, 32)) {
          try { out[key] = jsonSafe((value as Record<string, unknown>)[key], depth - 1); } catch { out[key] = null; }
        }
        return out;
      }
      return String(value);
    }

    function hubInfo(root: GameRoot) {
      const h = root.hubGoals as any;
      const goal = h.currentGoal ?? {};
      const definition = goal.definition ?? {};
      const hash = definition.getHash?.() ?? definition.cachedHash ?? null;
      const stored = h.storedShapes ?? {};
      return {
        level: h.level,
        goal: {
          hash, throughputOnly: !!goal.throughputOnly, required: goal.required ?? null, reward: goal.reward ?? null,
          delivered: typeof h.getCurrentGoalDelivered === 'function' ? h.getCurrentGoalDelivered() : null,
        },
        upgrades: jsonSafe(h.upgradeLevels),
        improvements: jsonSafe(h.upgradeImprovements),
        beltSpeed: typeof h.getBeltBaseSpeed === 'function' ? h.getBeltBaseSpeed() : null,
        minerSpeed: typeof h.getMinerBaseSpeed === 'function' ? h.getMinerBaseSpeed() : null,
        storedShapes: jsonSafe(stored),
      };
    }

    function entityAt(root: GameRoot, x: number, y: number, layer = 'regular'): any {
      return (root.map as any).getLayerContentXY(x, y, layer);
    }
    function regionEntities(root: GameRoot, region: Region, layers: string[]) {
      const found = new Set<any>();
      for (const layer of layers) {
        for (let y = region.y0; y < region.y1; y++) {
          for (let x = region.x0; x < region.x1; x++) {
            const entity = entityAt(root, x, y, layer);
            if (entity) found.add(entity);
          }
        }
      }
      return [...found];
    }
    function mapRegion(root: GameRoot, query: Query): Result {
      const r = query.region;
      if (!r) fail('REGION_INVALID');
      checkRegion(root,r,32);
      const layers = query.layer && query.layer !== 'both' ? [query.layer] : ['regular','wires'];
      const entities = regionEntities(root,r,layers);
      const ground: number[][] = [];
      const keys: string[] = [];
      for (let y = r.y0; y < r.y1; y++) {
        let last: number[] | undefined;
        for (let x = r.x0; x < r.x1; x++) {
          const chunk = root.map.chunksById.get(Math.floor(x/16) + '|' + Math.floor(y/16)) as any;
          const item = chunk.getLowerLayerFromWorldCoords(x,y);
          if (!item) { last = undefined; continue; }
          const key = patchKey(item)[1];
          let k = keys.indexOf(key);
          if (k === -1) k = keys.push(key)-1;
          if (last && last[3] === k) last[2]++;
          else { last = [x,y,1,k]; ground.push(last); }
        }
      }
      // Pins on a regular-layer machine are visible in the game's wires view.
      const pinRows: (string | number)[][] = [];
      if (query.layer === 'wires') {
        for (const e of regionEntities(root,r,['regular'])) {
          for (const [x,y,side,type] of ports(e,'WiredPins')) {
            if (contains(r,x,y)) pinRows.push([x,y,side,type === 'logicalEjector' ? 'out' : 'in']);
          }
        }
      }
      const region = [r.x0,r.y0,r.x1,r.y1];
      if (query.format !== 'image') {
        const rows = entities.map(e => {
          const p = e.components.StaticMapEntity;
          return [p.origin.x,p.origin.y,p.code,p.rotation];
        });
        return { data: { region, columns: ['x','y','code','rotation'], rows, keys, ground, ...(query.layer === 'wires' ? { pins:pinRows } : {}) } };
      }
      // Native blueprint sprites in world space, clipped by an offscreen canvas.
      const canvas = document.createElement('canvas');
      const scale = 0.75;
      canvas.width = (r.x1-r.x0)*32*scale;
      canvas.height = (r.y1-r.y0)*32*scale;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#333c49';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.scale(scale,scale);
      ctx.translate(-r.x0*32,-r.y0*32);
      for (const [x,y,w,k] of ground) {
        ctx.fillStyle = keys[k].startsWith('color:') ? keys[k].slice(6) : '#657788';
        ctx.fillRect(x*32,y*32,w*32,32);
      }
      ctx.strokeStyle = '#ffffff24';
      ctx.beginPath();
      for (let x=r.x0;x<r.x1;x++) { ctx.moveTo(x*32,r.y0*32); ctx.lineTo(x*32,r.y1*32); }
      for (let y=r.y0;y<r.y1;y++) { ctx.moveTo(r.x0*32,y*32); ctx.lineTo(r.x1*32,y*32); }
      ctx.stroke();
      const params = { context: ctx, visibleRect: new (engine().Rectangle)(r.x0*32,r.y0*32,(r.x1-r.x0)*32,(r.y1-r.y0)*32),
        desiredAtlasScale: 0.75, zoomLevel: scale, root };
      for (const e of entities) {
        const p = e.components.StaticMapEntity;
        const sprite = p.getBlueprintSprite();
        if (sprite) p.drawSpriteOnBoundsClipped(params,sprite,0,p.origin);
        else {
          const b = p.getTileSpaceBounds();
          ctx.fillStyle = p.getSilhouetteColor() || '#ddd';
          ctx.fillRect(b.x*32+1,b.y*32+1,b.w*32-2,b.h*32-2);
          ctx.fillStyle = '#172028';
          ctx.fillText(String(p.code),b.x*32+4,b.y*32+18);
        }
      }
      for (const [x,y,side,type] of pinRows) {
        const dx = side === 'right' ? 1 : side === 'left' ? -1 : 0;
        const dy = side === 'bottom' ? 1 : side === 'top' ? -1 : 0;
        const px = Number(x)*32+16+dx*10, py = Number(y)*32+16+dy*10;
        const sign = type === 'out' ? 1 : -1;
        ctx.fillStyle = type === 'out' ? '#ffbd64' : '#8af4fe';
        ctx.beginPath();
        ctx.moveTo(px+5*dx*sign,py+5*dy*sign);
        ctx.lineTo(px-4*dx*sign+4*dy,py-4*dy*sign-4*dx);
        ctx.lineTo(px-4*dx*sign-4*dy,py-4*dy*sign+4*dx);
        ctx.fill();
      }
      const image = canvas.toDataURL('image/png').split(',')[1];
      return { image, data: { region, count: entities.length, width: canvas.width, height: canvas.height,
        bytes: image.length*3/4 - (image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0) } };
    }
    function itemKey(item: any) {
      return item?.definition?.getHash?.() ?? item?.color ?? item?.getAsCopyableKey?.() ?? null;
    }
    function ports(entity: any, component: string) {
      const position = entity.components.StaticMapEntity;
      return (entity.components[component]?.slots ?? []).map((slot: any) => {
        const tile = position.localTileToWorld(slot.pos);
        return [tile.x, tile.y, position.localDirectionToWorld(slot.direction), slot.type ?? slot.filter]
          .filter(value => value !== undefined && value !== null);
      });
    }
    function speedsInfo(root: GameRoot) {
      const h = root.hubGoals as any;
      const types = ['cutter', 'rotater', 'rotaterCCW', 'rotater180', 'stacker', 'mixer',
        'painter', 'painterDouble', 'painterQuad', 'cutterQuad', 'balancer', 'reader'];
      const processors: Record<string, number | null> = {};
      for (const type of types) {
        try { processors[type] = typeof h.getProcessorBaseSpeed === 'function' ? h.getProcessorBaseSpeed(type) : null; }
        catch { processors[type] = null; }
      }
      return {
        belt: typeof h.getBeltBaseSpeed === 'function' ? h.getBeltBaseSpeed() : null,
        undergroundBelt: typeof h.getUndergroundBeltBaseSpeed === 'function' ? h.getUndergroundBeltBaseSpeed() : null,
        miner: typeof h.getMinerBaseSpeed === 'function' ? h.getMinerBaseSpeed() : null,
        processors, fullBelt: Object.fromEntries(Object.entries({ miner: h.getMinerBaseSpeed(), ...processors })
          .filter(([, speed]) => speed && speed > 0)
          .map(([id, speed]) => [id, Math.ceil(h.getBeltBaseSpeed() / (speed! * (id === 'painterDouble' ? 2 : 1)) - 1e-9)])),
        upgrades: jsonSafe(h.upgradeLevels),
        improvements: jsonSafe(h.upgradeImprovements),
      };
    }

    function buildingInfo(root: GameRoot, query: Query) {
      const tile = query.at ?? query.tiles?.[0];
      if (!tile) fail('CAPABILITY_UNVERIFIED');
      const entity = entityAt(root, tile.x, tile.y, query.layer);
      if (!entity) return { found: false };
      const position = entity.components.StaticMapEntity;
      if (!position) fail('CAPABILITY_UNVERIFIED');
      let id: string | null = null;
      try { id = position.getMetaBuilding().getId(); } catch { id = null; }
      let bounds: any = null;
      try { const b = position.getTileSpaceBounds(); bounds = { x: b.x, y: b.y, w: b.w, h: b.h }; } catch { bounds = null; }
      return {
        found: true, id, rotation: position.rotation, rotationVariant: position.getRotationVariant(),
        bounds, code: position.code, layer: entity.layer,
        acceptors: ports(entity, 'ItemAcceptor'), ejectors: ports(entity, 'ItemEjector'),
        pins: ports(entity, 'WiredPins'), pinValues: entity.components.WiredPins?.slots.map((s: any) =>
          [s.linkedNetwork?.uid ?? null, itemKey(s.linkedNetwork?.currentValue), !!s.linkedNetwork?.valueConflict]),
        network: entity.components.Wire ? { color: entity.components.Wire.variant,
          id: entity.components.Wire.linkedNetwork?.uid ?? null, conflict: !!entity.components.Wire.linkedNetwork?.valueConflict,
          value: itemKey(entity.components.Wire.linkedNetwork?.currentValue) } : undefined,
        storage: entity.components.Storage ? [itemKey(entity.components.Storage.storedItem),entity.components.Storage.storedCount] : undefined,
        reader: entity.components.BeltReader ? [itemKey(entity.components.BeltReader.lastItem),entity.components.BeltReader.lastThroughput] : undefined,
        signal: itemKey(entity.components.ConstantSignal?.signal), toggled: entity.components.Lever?.toggled,
        belt: entity.components.Belt ? [position.localDirectionToWorld('bottom'),
          position.localDirectionToWorld(entity.components.Belt.direction)] : undefined,
      };
    }

    function flowInfo(root: GameRoot, query: Query) {
      const region = query.region;
      if (!region) fail('REGION_INVALID');
      checkRegion(root, region, 64);
      const belts = regionEntities(root, region, ['regular']).filter(e => e.components.Belt);
      const paths = new Set(belts.map(e => e.components.Belt.assignedPath).filter(Boolean));
      const kinds: Record<string, number> = {};
      const where: Record<string, number[][]> = {};
      const points = (query.points ?? []).map(p => ({ at: [p.x,p.y], items: [] as string[] }));
      if (points.some(p => !contains(region, p.at[0], p.at[1]))) fail('REGION_INVALID');
      let total = 0;
      for (const path of paths) {
        let distance = path.spacingToFirstItem;
        let index = 0;
        let end = path.entityPath[0].components.Belt.getEffectiveLengthTiles();
        for (const [gap, item] of path.items) {
          while (distance > end && index + 1 < path.entityPath.length) {
            end += path.entityPath[++index].components.Belt.getEffectiveLengthTiles();
          }
          distance += gap;
          const { x, y } = path.entityPath[index].components.StaticMapEntity.origin;
          if (!contains(region, x, y)) continue;
          const key = String(itemKey(item) ?? '?');
          total++;
          kinds[key] = (kinds[key] ?? 0) + 1;
          const locations = where[key] ??= [];
          if (locations.length < 8) locations.push([x,y]);
          for (const p of points) if (p.at[0] === x && p.at[1] === y) p.items.push(key);
        }
      }
      return { total, belts: belts.length, kinds, where, points };
    }
    function checkSignals(root: GameRoot, q: Query) {
      if (!q.tiles?.length || (q.network !== undefined && q.reference) ||
          (q.referencePin !== undefined && !q.reference)) fail('ARGUMENT_INVALID');
      const pin = q.pin ?? 0;
      const networkAt = (p: Point, slot: number) => {
        const c = entityAt(root,p.x,p.y,q.layer ?? 'wires')?.components;
        return (slot === 0 && c?.Wire ? c.Wire.linkedNetwork : c?.WiredPins?.slots[slot]?.linkedNetwork) ?? null;
      };
      const reference = q.reference && networkAt(q.reference,q.referencePin ?? pin);
      if (q.reference && (!reference || reference.valueConflict)) {
        fail('SIGNAL_REFERENCE_INVALID');
      }
      const expected = reference?.uid ?? q.network;
      const issues = [];
      for (const at of q.tiles) {
        const n = networkAt(at,pin);
        const value = itemKey(n?.currentValue);
        const reason = !n ? 'disconnected' : n.valueConflict ? 'conflict' :
          expected !== undefined && n.uid !== expected ? 'wrong_network' :
          q.value !== undefined && value !== q.value ? 'wrong_value' : null;
        if (reason) issues.push({at:[at.x,at.y],reason,network:n?.uid ?? null,value});
      }
      return {checked:q.tiles.length,failed:issues.length,...(issues.length && {issues,expected:expected ?? undefined,value:q.value})};
    }
    // Use only adjacent, facing material ports. A BeltPath can represent hundreds of tiles.
    function traceFlow(root: GameRoot, q: Query) {
      if (!q.at) fail('ARGUMENT_INVALID');
      const start = entityAt(root,q.at.x,q.at.y);
      if (!start) return {state:'empty_tile'};
      const names = ['top','right','bottom','left'];
      const coords = (e: any) => {
        const {x,y} = e.components.StaticMapEntity.origin;
        return [x,y];
      };
      const describe = (e: any) => ({at:coords(e),building:metaIdOf(e)});
      const materialPorts = (e: any, output: boolean): any[][] => {
        const c = e.components;
        if (!c.Belt) return ports(e,output ? 'ItemEjector' : 'ItemAcceptor');
        return [[...coords(e),c.StaticMapEntity.localDirectionToWorld(output ? c.Belt.direction : 'bottom')]];
      };
      const neighbor = (port: any[], output: boolean) => {
        const [x,y,side] = port, d = names.indexOf(side);
        if (d < 0) return;
        const nx=x+offsets[d][0], ny=y+offsets[d][1];
        const e=entityAt(root,nx,ny);
        if (e && materialPorts(e,!output).some(([a,b,v])=>a===nx && b===ny && v===names[(d+2)%4])) return e;
      };
      // Follow only filter outlets that can serve this input under the current signal.
      function filterFeeds(source:any, port:any[]) {
        if(!source.components.Filter)return true;
        const n=source.components.WiredPins?.slots[0]?.linkedNetwork;
        if(!n?.currentValue || n.valueConflict)return false;
        const signal=itemKey(n.currentValue);
        const d=names.indexOf(port[2]), x=port[0]+offsets[d][0], y=port[1]+offsets[d][1];
        const slot=materialPorts(source,true).findIndex(([px,py,side])=>
          x===px && y===py && side===names[(d+2)%4]);
        if(signal==='1' || signal==='0')return slot===(signal==='1'?0:1);
        const input=materialPorts(source,false)[0];
        if(!input)return true;
        let feeder=neighbor(input,false);
        const head=feeder?.components.Belt?.assignedPath?.entityPath[0];
        if(head)feeder=neighbor(materialPorts(head,false)[0],false);
        const stock=feeder?.components.Storage?.storedItem;
        return !stock || slot===(itemKey(stock)===signal?0:1);
      }
      const tunnelPeer = (e: any, forward: boolean) => {
        const c=e.components, u=c.UndergroundBelt, p=c.StaticMapEntity;
        const d=names.indexOf(p.localDirectionToWorld(forward?'top':'bottom'));
        for(let i=1;i<=(u.tier===0?5:9);i++){
          const other=entityAt(root,p.origin.x+i*offsets[d][0],p.origin.y+i*offsets[d][1]);
          const peer=other?.components.UndergroundBelt;
          if(peer?.tier===u.tier && other.components.StaticMapEntity.rotation===p.rotation)
            return peer.mode!==u.mode ? other : null;
        }
      };
      let visited=0;
      // Confirm a held cutter output leads to full storage along a single material route.
      function fullOutlet(cutter: any) {
        const slots=cutter.components.ItemEjector?.slots ?? [];
        for(const [i,port] of materialPorts(cutter,true).entries()){
          if(!slots[i]?.item || slots[i].progress<1) continue;
          let e=neighbor(port,true);
          const seen=new Set();
          while(e && !seen.has(e) && visited<2048){
            seen.add(e); visited++;
            const c=e.components, path=c.Belt?.assignedPath;
            if(c.Storage?.getIsFull?.()) return {cutter:coords(cutter),slot:i,storage:coords(e),stock:c.Storage.storedCount};
            if(path && path.canAcceptItem()) break;
            if(c.UndergroundBelt?.mode==='sender'){e=tunnelPeer(e,true);continue}
            if(!path && !c.UndergroundBelt && c.ItemProcessor?.type!=='balancer') break;
            const tail=path?.entityPath[path.entityPath.length-1] ?? e;
            const outputs=materialPorts(tail,true);
            if(outputs.length!==1) break;
            e=neighbor(outputs[0],true);
          }
        }
      }
      const queue=[{entity:start,wait:undefined as Record<string,unknown>|undefined}];
      const seen=new Set<any>();
      let firstWait: Record<string,unknown>|undefined;
      for(let head=0;head<queue.length && visited<2048;head++){
        const {entity:e,wait}=queue[head];
        const c=e.components, path=c.Belt?.assignedPath;
        if(seen.has(path ?? e))continue;
        seen.add(path ?? e); visited++;
        if(e===start && path?.items.length && !path.boundAcceptor)
          return {state:'finding',reason:'unconnected_output',at:coords(path.entityPath[path.entityPath.length-1]),items:path.items.length};
        const ip=c.ItemProcessor;
        if(ip?.type==='cutterQuad'){
          const full=fullOutlet(e);
          if(full)return {state:'finding',reason:'cutter_output_backed_up',...full,upstreamOf:wait,visited};
        }
        if(c.Storage?.storedCount>0)continue;
        const upstreamOf=c.Storage ? {...wait,emptyStorage:coords(e),stock:0} : wait;
        if(c.UndergroundBelt?.mode==='receiver'){
          const peer=tunnelPeer(e,false);
          if(peer)queue.push({entity:peer,wait:upstreamOf});
          else return {state:'finding',reason:'unpaired_receiver',...describe(e),visited};
          continue;
        }
        const entry=path?.entityPath[0] ?? e;
        const inputs=materialPorts(entry,false);
        const required=ip && ['stacker','mixer','painter','painterDouble','painterQuad','cutter','cutterQuad','rotater','rotaterCCW','rotater180'].includes(ip.type);
        for(const [slot,port] of inputs.entries()){
          if(required && (ip.inputSlots.has(slot) || ip.ongoingCharges.length || ip.queuedEjects.length))continue;
          if(ip?.type==='painterQuad' && slot>0){
            const n=c.WiredPins.slots[slot-1]?.linkedNetwork;
            if(!n?.currentValue || n.valueConflict || itemKey(n.currentValue)==='0')continue;
          }
          const evidence=required ? {...describe(e),missingSlot:slot,input:port[3]} : undefined;
          const nextWait=upstreamOf ?? evidence;
          firstWait ??= evidence;
          const source=neighbor(port,false);
          if(source){
            if(filterFeeds(source,port))queue.push({entity:source,wait:nextWait});
          }
          else if(required || (path && e===start && !path.items.length))
            return {state:'finding',reason:'unconnected_input',...describe(entry),slot,visited};
        }
      }
      return {state:'inconclusive',visited,...(visited>=2048 && {limit:2048}),...(firstWait && {waiting:firstWait})};
    }
    function pathInfo(root: GameRoot, query: Query) {
      const tile = query.at ?? query.tiles?.[0];
      if (!tile) fail('CAPABILITY_UNVERIFIED');
      const entity = entityAt(root, tile.x, tile.y, query.layer);
      if (!entity) return { found: false };
      const belt = entity.components.Belt;
      if (!belt) return { found: true, isBelt: false };
      const path = belt.assignedPath;
      if (!path) return { found: true, isBelt: true, path: null };
      const entries = path.entityPath;
      let length = 0;
      let first: any = null;
      let last: any = null;
      if (entries && entries.length) {
        length = entries.length;
        const head = entries[0].components.StaticMapEntity;
        const tail = entries[entries.length - 1].components.StaticMapEntity;
        if (head) first = [head.origin.x, head.origin.y];
        if (tail) last = [tail.origin.x, tail.origin.y];
      }
      return {
        found: true, isBelt: true, length, first, last,
        boundAcceptor: !!path.boundAcceptor, direction: belt.direction,
      };
    }

    function dirToRotation(dir: string) {
      return dir === 'N' ? 0 : dir === 'E' ? 90 : dir === 'S' ? 180 : 270;
    }
    function rotationToDir(rotation: number) {
      const value = ((rotation % 360) + 360) % 360;
      return value === 0 ? 'N' : value === 90 ? 'E' : value === 180 ? 'S' : 'W';
    }
    function beltEntityAt(root: GameRoot, x: number, y: number) {
      const entity = entityAt(root, x, y);
      return entity?.components.Belt ? entity : null;
    }
    function metaIdOf(entity: any) {
      try { return entity.components.StaticMapEntity.getMetaBuilding().getId(); } catch { return null; }
    }

    function previewBelts(root: GameRoot, query: Query) {
      const ops = query.ops ?? [];
      const region = query.region;
      if (!region) fail('REGION_INVALID');
      checkRegion(root, region, 64);
      if (ops.length === 0 || ops.length > 8) fail('REGION_INVALID');
      const targets = new Map<string, any>();
      for (const op of ops) {
        const tile = op.tile;
        if (!tile || !contains(region, tile.x, tile.y)) fail('REGION_INVALID');
        const key = tile.x + ',' + tile.y;
        if (targets.has(key)) fail('CONFLICT');
        const existing = beltEntityAt(root, tile.x, tile.y);
        if (op.op === 'place_straight') {
          if (entityAt(root,tile.x,tile.y)) fail('CONFLICT');
        } else if (op.op === 'replace_straight') {
          if (!existing || metaIdOf(existing) !== 'belt') fail('CONFLICT');
          if (existing.components.StaticMapEntity.getRotationVariant() !== 0) fail('CONFLICT');
        } else {
          fail('CAPABILITY_UNVERIFIED');
        }
        targets.set(key, {
          x: tile.x, y: tile.y, to: op.to,
          before: existing ? rotationToDir(existing.components.StaticMapEntity.rotation) : null,
          code: existing ? existing.components.StaticMapEntity.code : null,
          rotation: existing ? existing.components.StaticMapEntity.rotation : 0,
        });
      }
      const cells: any[] = [];
      const before: any[] = [];
      for (const target of targets.values()) {
        cells.push({ tile: { x: target.x, y: target.y }, before: target.before, after: target.to, role: 'requested' });
        before.push({ x: target.x, y: target.y, code: target.code, rotation: target.rotation });
      }
      const neighborKeys = new Set<string>();
      for (const target of targets.values()) {
        for (const delta of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = target.x + delta[0];
          const ny = target.y + delta[1];
          const key = nx + ',' + ny;
          if (targets.has(key) || neighborKeys.has(key)) continue;
          if (!contains(region, nx, ny)) continue;
          if (beltEntityAt(root, nx, ny)) neighborKeys.add(key);
        }
      }
      for (const key of neighborKeys) {
        if (cells.length >= 32) break;
        const parts = key.split(',');
        const neighbor = beltEntityAt(root, Number(parts[0]), Number(parts[1]));
        if (!neighbor) continue;
        const direction = rotationToDir(neighbor.components.StaticMapEntity.rotation);
        cells.push({ tile: { x: Number(parts[0]), y: Number(parts[1]) }, before: direction, after: direction, role: 'neighbor' });
      }
      return { epoch: settings.seed + '_' + generation, cells, before };
    }

    function tileState(root: GameRoot, tile: Point) {
      const entity = entityAt(root, tile.x, tile.y);
      const p = entity?.components.StaticMapEntity;
      return { x: tile.x, y: tile.y, code: p?.code ?? null, rotation: p?.rotation ?? 0 };
    }
    function unchanged(root: GameRoot, expected: any[] | undefined) {
      return expected?.every(t => {
        const now = tileState(root,t);
        return now.code === t.code && now.rotation === t.rotation;
      });
    }
    function applyBelts(root: GameRoot, query: Query) {
      if (query.epoch !== epoch()) fail('SESSION_CHANGED');
      if (!unchanged(root, query.snapshotTiles)) fail('CONFLICT');
      const items = query.ops!.map(op => ({ ...op.tile, code: 1, direction: op.to }));
      const result = immutablePlace(root, items);
      const after = items.map(t => tileState(root,t));
      return { completed: result.placed, after, verified: after.every((t,i) =>
        t.code === 1 && t.rotation === dirToRotation(items[i].direction)) };
    }
    function restoreTiles(root: GameRoot, query: Query) {
      if (query.epoch !== epoch()) fail('SESSION_CHANGED');
      if (!unchanged(root, query.expected)) fail('RESTORE_CONFLICT');
      let restored = 0;
      root.logic.performImmutableOperation(() => {
        for (const tile of query.snapshotTiles!) {
          const existing = entityAt(root,tile.x,tile.y);
          if (tile.code === null) {
            if (existing && !root.logic.tryDeleteBuilding(existing)) break;
          } else if (!placeBuildings(root,[tile]).placed) break;
          restored++;
        }
      });
      return { restored };
    }
    function blueprintOp(root: GameRoot, query: Query) {
      if (!root.hubGoals.isRewardUnlocked('reward_blueprints')) fail('BUILDING_LOCKED');
      const gameMode = (root as any).gameMode;
      if (query.handle && query.blueprint) fail('ARGUMENT_INVALID');
      if (query.blueprintMode !== 'paste') {
        const region = query.region;
        if (!region) fail('REGION_INVALID');
        checkRegion(root,region,64);
        const source = regionEntities(root,region,[query.layer ?? 'regular'])
          .filter(entity => root.logic.canDeleteBuilding(entity));
        if (!source.length || source.length > 4096) fail('BLUEPRINT_INVALID');
        const blueprint = engine().Blueprint.fromUids(root,source.map(entity => entity.uid));
        // Normalize the native clipboard's pivot to the selected rectangle's top left.
        const orig = source[0].components.StaticMapEntity.origin;
        const copy = blueprint.entities[0].components.StaticMapEntity.origin;
        const shift = vec(orig.x - copy.x - region.x0, orig.y - copy.y - region.y0);
        for (const entity of blueprint.entities) entity.components.StaticMapEntity.origin.addInplace(shift);
        const handle = epoch() + '.' + ++clipboardId;
        if (clipboards.size >= 16) clipboards.delete(clipboards.keys().next().value!);
        clipboards.set(handle,{ blueprint, anchor: { x: region.x0, y: region.y0 } });
        const items = query.portable ? blueprint.entities.map((e: any) => {
          const p = e.components.StaticMapEntity;
          return { x: p.origin.x, y: p.origin.y, code: p.code, rotation: p.rotation,
            value: e.components.Lever ? String(!!e.components.Lever.toggled) :
              e.components.ConstantSignal?.signal?.getAsCopyableKey?.() };
        }) : undefined;
        return { handle, count: source.length, origin: [region.x0,region.y0], cost: gameMode.getHasFreeCopyPaste() ? 0 : blueprint.getCost(), items };
      }
      let clip = clipboards.get(query.handle ?? '');
      if (query.blueprint && !query.handle) {
        if (!query.blueprint.length) fail('BLUEPRINT_INVALID');
        const occupied = new Set<string>();
        const entities = query.blueprint.map(item => {
          const args = placement(root,item);
          if (!args) fail('BUILDING_LOCKED');
          const entity = args.building.createEntity({root,...args});
          const b = entity.components.StaticMapEntity.getTileSpaceBounds();
          for (let y=b.y; y<b.y+b.h; y++) for (let x=b.x; x<b.x+b.w; x++) {
            const key = entity.layer + ',' + x + ',' + y;
            if (occupied.has(key)) fail('BLUEPRINT_INVALID');
            occupied.add(key);
          }
          if (item.value !== undefined) setValue(root,entity,item.value);
          return entity;
        });
        clip = { blueprint: new (engine().Blueprint)(entities), anchor: { x: 0, y: 0 } };
      }
      if (!clip) fail('BLUEPRINT_INVALID');
      const blueprint = new (engine().Blueprint)(clip.blueprint.entities.map((e: any) => e.clone()));
      for (let i = 0; i < (query.rotation ?? 0) / 90; i++) blueprint.rotateCw();
      const targets = query.targets ?? (query.at ? [query.at] : [{
        x: clip.anchor.x + (query.dx ?? 0), y: clip.anchor.y + (query.dy ?? 0) }]);
      if (targets.length * blueprint.entities.length > 4096) fail('REGION_INVALID');
      let copies = 0;
      let spent = 0;
      for (const target of targets) {
        const offset = vec(target.x,target.y);
        if (!blueprint.canAfford(root)) return { copies, spent, stoppedAt: [target.x,target.y], reason: 'BLUEPRINT_COST' };
        // The UI accepts partial blueprints. For automation check every footprint before spending.
        if (!blueprint.entities.every((e: any) => root.logic.checkCanPlaceEntity(e,{offset})) ||
            !blueprint.tryPlace(root,offset)) return { copies, spent, stoppedAt: [target.x,target.y], reason: 'CONFLICT' };
        if (!gameMode.getHasFreeCopyPaste()) {
          const cost = blueprint.getCost();
          root.hubGoals.takeShapeByKey(gameMode.getBlueprintShapeKey(),cost);
          spent += cost;
        }
        copies++;
      }
      return { copies, placed: copies * blueprint.entities.length, spent };
    }

    function sampleInfo(root: GameRoot, query: Query) {
      const flow = flowInfo(root, query);
      const h = root.hubGoals as any;
      return {
        flow, epoch: epoch(), level: h.level, goal: h.currentGoal?.definition?.getHash?.() ?? null,
        throughputOnly: !!h.currentGoal?.throughputOnly,
        delivered: typeof h.getCurrentGoalDelivered === 'function' ? h.getCurrentGoalDelivered() : null,
        at: Date.now(),
      };
    }

    const beltTurns: Record<string, [number, number]> = {
      'N>E': [180, 1], 'N>S': [180, 0], 'N>W': [180, 2],
      'E>N': [270, 2], 'E>S': [270, 1], 'E>W': [270, 0],
      'S>N': [0, 0], 'S>E': [0, 2], 'S>W': [0, 1],
      'W>N': [90, 1], 'W>E': [90, 0], 'W>S': [90, 2],
    };
    const beltDirections: Record<string, number> = { N: 0, E: 90, S: 180, W: 270 };

    function resolveTurn(item: any) {
      if (item && typeof item.from === 'string' && typeof item.to === 'string') {
        const match = beltTurns[item.from + '>' + item.to];
        if (match) return { rotation: match[0], rotationVariant: match[1] };
      }
      if (item && typeof item.direction === 'string' && beltDirections[item.direction] !== undefined) {
        return { rotation: beltDirections[item.direction], rotationVariant: 0 };
      }
      return null;
    }

    let catalogCache: any[] | null = null;

    function resolveCode(item: any) {
      if (item && Number.isInteger(item.code)) return item.code;
      if (!item || typeof item.building !== 'string') return Number(item && item.code);
      if (!catalogCache) catalogCache = catalog().entries;
      const wantedVariant = typeof item.variant === 'string' ? item.variant : null;
      const match = catalogCache.find((entry: any) =>
        entry.id === item.building && (wantedVariant === null || entry.variant === wantedVariant));
      return match ? match.code : Number.NaN;
    }

    function available(root: GameRoot, building: any, variant: string) {
      const parts = (root as any).hud.parts;
      const id = building.getId();
      const handle = parts.buildingsToolbar?.buildingHandles[id] ?? parts.wiresToolbar?.buildingHandles[id];
      return !!handle && !handle.puzzleLocked &&
        building.getIsUnlocked(root) && building.getAvailableVariants(root).includes(variant);
    }
    function placement(root: GameRoot, item: any) {
      const code = resolveCode(item);
      if (!Number.isInteger(code)) return null;
      const data = engine().getBuildingDataFromCode(code);
      const building = data?.metaInstance;
      if (!building || !available(root,building,data.variant)) return null;
      const turned = resolveTurn(item);
      const rotation = turned?.rotation ?? item.rotation ?? 0;
      const rotationVariant = turned?.rotationVariant ?? item.rotationVariant ?? data.rotationVariant;
      const variant = item.variant ?? data.variant;
      if (item.from || item.to) {
        if (!turned || !beltTurns[item.from + '>' + item.to] || building.getId() !== 'belt') return null;
      }
      if (!available(root,building,variant) || ![0,90,180,270].includes(rotation)) return null;
      if (!catalogCache) catalogCache = catalog().entries;
      if (!catalogCache!.some(e => e.id === building.getId() && e.variant === variant && e.rotationVariant === rotationVariant)) return null;
      return { origin: vec(item.x,item.y), rotation, originalRotation: rotation, rotationVariant, variant, building };
    }
    function placeBuildings(root: GameRoot, items: any[], emptyOnly = false) {
      if (!items.length) fail('ARGUMENT_INVALID');
      let placed = 0;
      for (const item of items) {
        try {
          const args = placement(root,item);
          if (args && emptyOnly) {
            const example = args.building.createEntity({root,...args});
            if (!root.logic.checkCanPlaceEntity(example,{allowReplaceBuildings:false}) ||
                (example.layer === 'regular' && ports(example,'WiredPins').some(([x,y]:any[])=>entityAt(root,x,y,'wires')))) {
              return { requested:items.length, placed, skipped:items.length-placed-1, stoppedAt:[item.x,item.y], reason:'CONFLICT' };
            }
          }
          if (!args || !root.logic.tryPlaceBuilding(args)) {
            return { requested: items.length, placed, skipped:items.length-placed-1, stoppedAt: [item.x,item.y], reason: args ? 'CONFLICT' : 'BUILDING_LOCKED' };
          }
          placed++;
        } catch {
          return { requested: items.length, placed, skipped:items.length-placed-1, stoppedAt: [item.x,item.y], reason: 'rejected' };
        }
      }
      return { requested: items.length, placed };
    }
    function immutablePlace(root: GameRoot, items: any[], emptyOnly = false): ReturnType<typeof placeBuildings> {
      return root.logic.performImmutableOperation(() => placeBuildings(root,items,emptyOnly));
    }
    const offsets = [[0,-1],[1,0],[0,1],[-1,0]];
    const sides = ['N','E','S','W'];
    function expandRoute(waypoints: Point[]) {
      if (waypoints.length < 2) fail('REGION_INVALID');
      const route = [waypoints[0]];
      const seen = new Set([waypoints[0].x + ',' + waypoints[0].y]);
      for (const b of waypoints.slice(1)) {
        const a = route[route.length-1];
        const dx = b.x-a.x, dy = b.y-a.y;
        const length = Math.abs(dx) + Math.abs(dy);
        if (!length || (dx && dy) || route.length + length > 512) fail('REGION_INVALID');
        for (let n=1; n<=length; n++) {
          const x = a.x + n*Math.sign(dx), y = a.y + n*Math.sign(dy);
          const key = x + ',' + y;
          if (seen.has(key)) fail('CONFLICT');
          seen.add(key);
          route.push({x,y});
        }
      }
      return route;
    }
    function routeBelts(root: GameRoot, query: Query) {
      const route = expandRoute(query.route ?? []);
      const direction = (a: Point,b: Point) => offsets.findIndex(([x,y]) => b.x-a.x === x && b.y-a.y === y);
      if (query.routeCode !== undefined && query.routeCode !== 1) fail('ARGUMENT_INVALID');
      const items = route.map((p,i) => {
        const incoming = i ? direction(route[i-1],p) : direction(p,route[1]);
        const outgoing = i+1 < route.length ? direction(p,route[i+1]) : incoming;
        const existing = entityAt(root,p.x,p.y);
        if (existing && !existing.components.Belt) fail('CONFLICT');
        return { ...p, code: 1, from: sides[(incoming+2)%4], to: sides[outgoing] };
      });
      const result = immutablePlace(root,items);
      const verified = result.placed === items.length && items.every(item => {
        const p = entityAt(root,item.x,item.y)?.components.StaticMapEntity;
        const [rotation, variant] = beltTurns[item.from + '>' + item.to];
        return p?.rotation === rotation && p.getRotationVariant() === variant;
      });
      return { ...result, verified };
    }
    function routeWire(root: GameRoot, query: Query) {
      const route = expandRoute(query.route ?? []);
      const color = query.color ?? 'first';
      const indexes = new Map(route.map((p,i) => [p.x + ',' + p.y,i]));
      const items = [];
      let outputs = 0;
      for (const [i,p] of route.entries()) {
        const existing = entityAt(root,p.x,p.y,'wires');
        if (existing && existing.components.Wire?.variant !== color) fail('CONFLICT');
        if (existing && !query.join) fail('WIRE_CONTACT');
        const below = entityAt(root,p.x,p.y);
        if (below && ports(below,'WiredPins').some(([x,y]: any[]) => x === p.x && y === p.y)) fail('CONFLICT');
        for (const [dx,dy] of offsets) {
          const x = p.x+dx, y = p.y+dy;
          const other = indexes.get(x + ',' + y);
          if (other !== undefined && Math.abs(i-other) === 1) continue;
          if (query.join) continue;
          const neighbor = entityAt(root,x,y,'wires');
          if (other !== undefined || neighbor?.components.Wire?.variant === color || neighbor?.components.WireTunnel) fail('WIRE_CONTACT');
          // Endpoints may connect to pins along the entering/exiting direction.
          const inner = i === 0 ? route[1] : i === route.length-1 ? route[i-1] : null;
          const endpointPin = inner && inner.x === p.x-dx && inner.y === p.y-dy;
          const facing = dx === 1 ? 'left' : dx === -1 ? 'right' : dy === 1 ? 'top' : 'bottom';
          for (const entity of [neighbor,entityAt(root,x,y)]) {
            for (const [px,py,dir,type] of entity ? ports(entity,'WiredPins') : []) {
              if (px !== x || py !== y || dir !== facing) continue;
              if (!endpointPin || (type === 'logicalEjector' && ++outputs > 1)) fail('WIRE_CONTACT');
            }
          }
        }
        if (!existing) items.push({...p,code: color === 'first' ? 27 : 52});
      }
      const result = items.length ? placeBuildings(root,items) : { placed: 0 };
      return { ...result, reused: route.length - items.length, length: route.length };
    }
    function removeTiles(root: GameRoot, query: Query) {
      const layer = query.layer ?? 'regular';
      let entities: any[];
      if (query.region) {
        if (query.tiles) fail('ARGUMENT_INVALID');
        checkRegion(root,query.region,64);
        entities = regionEntities(root,query.region,[layer]);
      } else {
        if (!query.tiles?.length) fail('ARGUMENT_INVALID');
        entities = [...new Set(query.tiles.map(p => entityAt(root,p.x,p.y,layer)).filter(Boolean))];
      }
      let removed = 0;
      root.logic.performImmutableOperation(() => {
        for (const entity of entities) if (root.logic.tryDeleteBuilding(entity)) removed++;
      });
      return { removed, protected: entities.length-removed };
    }
    function setValue(root: GameRoot, entity: any, value: string) {
      if (entity?.components.Lever && ['true','false','0','1'].includes(value)) {
        entity.components.Lever.toggled = value === 'true' || value === '1';
      } else if (entity?.components.ConstantSignal) {
        const signal = (root as any).hud.parts.constantSignalEdit.parseSignalCode(entity,value);
        if (!signal) fail('ARGUMENT_INVALID');
        entity.components.ConstantSignal.signal = signal;
      } else fail('ARGUMENT_INVALID');
    }

    function unlockUpgrade(root: GameRoot, id: string) {
      const h = root.hubGoals as any;
      let can = false;
      try { can = typeof h.canUnlockUpgrade === 'function' ? !!h.canUnlockUpgrade(id) : false; } catch { can = false; }
      let ok = false;
      if (can) { try { ok = !!h.tryUnlockUpgrade(id); } catch { ok = false; } }
      return { id, can, ok, upgrades: jsonSafe(h.upgradeLevels) };
    }

    function catalog() {
      const shapez = (globalThis as any).shapez;
      const entries: any[] = [];
      for (let code = 1; code <= 200; code++) {
        try {
          const data = shapez.getBuildingDataFromCode?.(code);
          const meta = data && (data.metaInstance ?? data.metaClass);
          if (!meta) continue;
          entries.push({
            code,
            id: typeof meta.getId === 'function' ? meta.getId() : null,
            variant: data.variant ?? null,
            rotationVariant: data.rotationVariant ?? null,
          });
        } catch { /* code not mapped */ }
      }
      return { entries };
    }

    function gameOp(root: GameRoot, query: Query): Record<string, unknown> {
      const op = query.op;
      if (op === 'layer') {
        const world = root as any;
        if (query.layer && world.currentLayer !== query.layer) {
          world.hud.parts.wiresOverlay.switchLayers();
          if (world.currentLayer !== query.layer) fail('BUILDING_LOCKED');
        }
        return { layer: world.currentLayer };
      }
      if (op === 'save') {
        const state = root.gameState as any;
        if (!(root as any).gameMode.getIsSaveable() || !(root.savegame as any).isSaveable() ||
            (globalThis as any).APP_ERROR_OCCURED) fail('CAPABILITY_UNVERIFIED');
        if (state.currentSavePromise) return { state:'in_progress' };
        state.doSave();
        return { state:'requested' };
      }
      if (op === 'waypoints') return { rows: (root as any).hud.parts.waypoints.waypoints.map((w: any) =>
        [w.label ?? 'Hub', Math.floor(w.center.x/32), Math.floor(w.center.y/32), w.layer]) };
      if (op === 'view') {
        if (!query.at) fail('ARGUMENT_INVALID');
        (root.camera as any).setDesiredCenter(vec((query.at.x+0.5)*32,(query.at.y+0.5)*32));
        return { at:[query.at.x,query.at.y] };
      }
      if (op === 'hub') return hubInfo(root);
      if (op === 'speeds') return speedsInfo(root);
      if (op === 'trace') return traceFlow(root,query);
      if (op === 'check_signals' || (op==='signals' && (query.reference || query.network!==undefined || query.value!==undefined))) return checkSignals(root,query);
      if (op === 'signals') {
        if (!query.tiles?.length) fail('ARGUMENT_INVALID');
        return { rows: query.tiles.map(({x,y}) => {
          const e = entityAt(root,x,y,query.layer ?? 'wires');
          if (!e) return [x,y,null];
          const nets = e.components.Wire ? [e.components.Wire.linkedNetwork] :
            (e.components.WiredPins?.slots ?? []).map((s: any) => s.linkedNetwork);
          return [x,y,e.components.StaticMapEntity.code,...nets.map((n: any) => n ? [n.uid,itemKey(n.currentValue),+n.valueConflict] : null)];
        }) };
      }
      if (op === 'building') return buildingInfo(root, query);
      if (op === 'flow') return flowInfo(root, query);
      if (op === 'path') return pathInfo(root, query);
      if (op === 'blueprint') return blueprintOp(root, query);
      if (op === 'sample') return sampleInfo(root, query);
      if (op === 'preview') return previewBelts(root, query);
      if (op === 'applyBelts') return applyBelts(root, query);
      if (op === 'restoreTiles') return restoreTiles(root, query);
      if (op === 'route') return routeBelts(root, query);
      if (op === 'place') return immutablePlace(root, query.items ?? [],query.emptyOnly);
      if (op === 'remove') return removeTiles(root, query);
      if (op === 'wire') return routeWire(root,query);
      if (op === 'configure') {
        if (!query.at || query.value === undefined) fail('ARGUMENT_INVALID');
        setValue(root,entityAt(root,query.at.x,query.at.y,query.layer),query.value);
        return { configured: true };
      }
      if (op === 'upgrade') return unlockUpgrade(root, query.id ?? '');
      if (op === 'catalog') {
        catalogCache ??= catalog().entries;
        const entries = catalogCache.filter(e => !query.id || e.id === query.id).map(e => {
          const meta = engine().getBuildingDataFromCode(e.code).metaInstance;
          const row = [e.code,e.id,e.variant,e.rotationVariant,meta.getLayer(),+available(root,meta,e.variant)];
          if (!query.id) return row;
          const example = meta.createEntity({root,origin:vec(0,0),rotation:query.rotation ?? 0,
            originalRotation:query.rotation ?? 0,variant:e.variant,rotationVariant:e.rotationVariant});
          return [...row,ports(example,'ItemAcceptor'),ports(example,'ItemEjector'),ports(example,'WiredPins')];
        });
        return { columns: ['code','id','variant','rotationVariant','layer','available',...(query.id ? ['inputs','outputs','pins'] : [])], entries };
      }
      fail('CAPABILITY_UNVERIFIED');
    }

    return function dispatch(command: Command): Result {
      let root: GameRoot;
      try {
        root = activeGame();
      } catch (error) {
        clearSession();
        return typeof error === 'object' && error !== null && 'fault' in error
          ? error as Result : { fault: 'IDENTITY_UNKNOWN', inGame: null };
      }
      const saveId = (root.savegame as any).internalId as string;
      if(command.saveId && saveId!==command.saveId) return {fault:'SAVE_ID_MISMATCH',inGame:true};
      // The active world survives a CDP reconnect. Keep only recent keyed results on that world.
      const key = Symbol.for('shapez1-mcp.recent-write-results');
      let ledger: Map<string,Result>|undefined = (root as any)[key];
      if(command.lookup) return ledger?.get(command.journalKey!) ?? {fault:'OUTCOME_UNKNOWN',inGame:true};
      function execute(): Result {
        const { tool, query } = command;
        if (tool === 'status') return { data: status(root) };
        if (tool === 'map_region') return mapRegion(root,query);
        if (tool === 'screenshot') {
          if (typeof document === 'undefined') fail('CAPTURE_FAILED');
          return { data: { epoch: settings.seed + '_' + generation } };
        }
        if (tool === 'entities' || tool === 'resources') return observations(root, { ...command, tool });
        if (tool === 'game') {
          if (query.op === 'select') {
            if (query.id !== (root.savegame as any).internalId) { selected = false; fail('SAVE_ID_MISMATCH'); }
            selected = true;
            return { data: { id: query.id, epoch: epoch(), mode: settings.mode } };
          }
          const read = (query.op === 'layer' && !query.layer) || ['hub','signals','trace','check_signals','waypoints','catalog','speeds','building','flow','path','sample','preview'].includes(query.op ?? '') ||
            (query.op === 'blueprint' && query.blueprintMode !== 'paste');
          if (!read && settings.mode === 'observe') fail('READ_ONLY');
          if (!read && !selected && command.selectedSaveId===saveId) selected=true;
          if (!read && !selected) fail('SAVE_NOT_SELECTED');
          return { data: gameOp(root, query) };
        }
        if (tool === 'sample_flow') {
          checkRegion(root, query.region, 64);
          if (query.points?.some(point => !contains(query.region, point.x, point.y))) fail('REGION_INVALID');
        }
        fail('CAPABILITY_UNVERIFIED');
      }
      let result:Result;
      try {
        result=execute();
      } catch (error) {
        result=typeof error === 'object' && error !== null && 'fault' in error
          ? error as Result : { fault: command.journalKey?'OUTCOME_UNKNOWN':'CAPABILITY_UNVERIFIED', inGame: true };
      }
      result={...result,saveId};
      if(command.journalKey){
        if(!ledger){
          ledger=new Map();
          Object.defineProperty(root,key,{value:ledger,configurable:true});
        }
        ledger.set(command.journalKey,result);
        if(ledger.size>128)ledger.delete(ledger.keys().next().value!);
      }
      return result;
    };
  }
}
