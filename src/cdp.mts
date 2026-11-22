import { randomBytes } from 'node:crypto';
import { bindRenderer } from './renderer.mjs';
import { holdGameFrame, scaleCapturedPng, waitForGameFrame } from './screenshot.mjs';
import type { Command, Mode, Result } from './types.mjs';

const endpoint = 'http://127.0.0.1:9222/json';
const objectGroup = 'shapez1-observe';
type Remote = { objectId?: string; value?: unknown };
type Reply = { result?: Remote; exceptionDetails?: unknown; objects?: Remote; data?: string; protocolError?: boolean };
type Pending = { finish: (reply?: Reply) => void };
type Target = { type?: string; id?: string; url?: string; webSocketDebuggerUrl?: string };

export class CdpError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function getTarget() {
  let entries: Target[];
  try {
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error();
    entries = await response.json() as Target[];
  } catch {
    throw new CdpError('CDP_UNREACHABLE');
  }
  if (!Array.isArray(entries)) throw new CdpError('TARGET_INVALID');
  const matches = entries.filter(target => {
    try {
      const url = new URL(target.url ?? '');
      return target.type === 'page' && url.protocol === 'file:' && !url.host && !url.search && !url.hash &&
        /\/shapez\.io\/resources\/app\.asar\/index\.html$/i.test(decodeURIComponent(url.pathname));
    } catch {
      return false;
    }
  });
  const target = matches[0];
  if (matches.length !== 1 || !target.id || !/^[a-f0-9]{32}$/i.test(target.id) ||
      target.webSocketDebuggerUrl !== 'ws://127.0.0.1:9222/devtools/page/' + target.id) {
    throw new CdpError('TARGET_INVALID');
  }
  return { url: target.url!, socket: target.webSocketDebuggerUrl };
}

class Connection {
  readonly seed = randomBytes(12).toString('base64url');
  readonly #pending = new Map<number, Pending>();
  #requestId = 0;
  #closed = false;
  dispatcher?: string;
  onDebugEvent?: (method: string, functionName?: string) => void;

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('error', () => this.close());
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('message', ({ data }) => {
      try {
        const message = JSON.parse(String(data));
        if (message.id !== undefined) this.#pending.get(message.id)?.finish(message.error ? { protocolError: true } : message.result);
        if (message.method === 'Debugger.paused' || message.method === 'Debugger.resumed') {
          this.onDebugEvent?.(message.method, message.params?.callFrames?.[0]?.functionName);
        }
        if (message.method === 'Runtime.executionContextsCleared' ||
            message.method === 'Runtime.executionContextDestroyed' ||
            message.method === 'Inspector.detached') this.close();
      } catch {
        this.close();
      }
    });
  }

  get open() { return !this.#closed && this.socket.readyState === WebSocket.OPEN; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.finish();
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }

  send(method: string, params: Record<string, unknown> = {}) {
    if (!this.open) throw new CdpError('SESSION_CHANGED');
    const id = ++this.#requestId;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError('CDP_TIMEOUT'));
        this.close();
      }, method === 'Runtime.queryObjects' ? 35000 : 12000);
      const finish = (reply?: Reply) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (reply?.protocolError) reject(new CdpError(method === 'Page.captureScreenshot' ? 'CAPTURE_FAILED' : 'SESSION_CHANGED'));
        else if (reply) resolve(reply);
        else reject(new CdpError('SESSION_CHANGED'));
      };
      this.#pending.set(id, { finish });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.close();
      }
    });
  }
}

export class GameConnection {
  #active?: Connection;
  #saveId?: string;
  #selectedSaveId?: string;
  readonly #uncertain = new Map<string,{key:string;saveId:string}>();
  #opening?: Promise<Connection>;

  constructor(readonly mode: Mode) {}

  close() { this.#active?.close(); }

  async #connect() {
    const { url, socket: address } = await getTarget();
    const socket = new WebSocket(address);
    const connection = new Connection(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (open: boolean) => {
          clearTimeout(timer);
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('close', onClose);
          if (open) resolve();
          else reject(new CdpError('CDP_UNREACHABLE'));
        };
        const onOpen = () => finish(true);
        const onClose = () => finish(false);
        const timer = setTimeout(onClose, 2000);
        socket.addEventListener('open', onOpen);
        socket.addEventListener('close', onClose);
      });
      await connection.send('Runtime.enable');
      // Current builds publish the live Application. A heap query on a large factory
      // can stall for tens of seconds. Keep the prototype lookup for older builds.
      const singleton = await connection.send('Runtime.evaluate', {
        expression: 'window.shapez?.GLOBAL_APP?.stateMgr ? [window.shapez.GLOBAL_APP] : null',
        objectGroup, silent: true,
      });
      let objects = singleton.result;
      if (!objects?.objectId) {
        const { result: prototype } = await connection.send('Runtime.evaluate', {
          expression: 'window.shapez && window.shapez.Application.prototype', objectGroup, silent:true,
        });
        if (!prototype?.objectId) throw new CdpError('IDENTITY_UNKNOWN');
        objects = (await connection.send('Runtime.queryObjects', {prototypeObjectId:prototype.objectId,objectGroup})).objects;
      }
      if (!objects?.objectId) throw new CdpError('IDENTITY_UNKNOWN');
      const { result, exceptionDetails } = await connection.send('Runtime.callFunctionOn', {
        objectId: objects.objectId, functionDeclaration: bindRenderer.toString(), silent: true,
        arguments: [{ value: { href: url, seed: connection.seed, mode: this.mode } }],
        objectGroup: objectGroup + '-dispatcher',
      });
      await connection.send('Runtime.releaseObjectGroup', { objectGroup });
      if (exceptionDetails || !result?.objectId) throw new CdpError('IDENTITY_UNKNOWN');
      connection.dispatcher = result.objectId;
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async #get() {
    if (this.#active?.open) return this.#active;
    this.#opening ??= this.#connect().then(connection => this.#active = connection)
      .finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  async dispatch(command: Command & { connection?: string }):Promise<{response:Result;seed:string}> {
    const { tool, query } = command;
    const read = tool !== 'game' || ['hub','speeds','catalog','building','path','signals','trace','check_signals','flow','waypoints','sample','preview'].includes(query.op ?? '') ||
      (query.op==='layer' && !query.layer) || (query.op==='blueprint' && query.blueprintMode!=='paste');
    if(read && tool!=='status' && !command.saveId && !this.#saveId){
      const check=await this.dispatch({tool:'status',query:{},view:'identity'});
      if(!check.response.data)return check;
    }
    const saveId: string|undefined = command.saveId ?? (tool==='status' || query.op==='select' ? undefined : this.#saveId);
    const journalKey = !read && query.requestId ? randomBytes(12).toString('hex') : undefined;
    if(query.op==='select')this.#selectedSaveId=undefined;
    const guarded = {...command, saveId, journalKey, selectedSaveId:this.#selectedSaveId};
    const remember = (result: {response:Result;seed:string}) => {
      if(result.response.saveId){
        this.#saveId=result.response.saveId;
        if(this.#selectedSaveId!==this.#saveId)this.#selectedSaveId=undefined;
        if(query.op==='select' && result.response.data)this.#selectedSaveId=this.#saveId;
      }
      return result;
    };
    try {
      const result=await this.#dispatchOnce(guarded);
      if(journalKey && result.response.fault==='OUTCOME_UNKNOWN')throw new CdpError('OUTCOME_UNKNOWN');
      if(result.response.fault!=='SESSION_CHANGED' || !read || query.cursor) return remember(result);
    } catch (error) {
      if(error instanceof CdpError && error.code==='OUTCOME_UNKNOWN' && journalKey && saveId && query.requestId){
        this.#uncertain.set(query.requestId,{key:journalKey,saveId});
        const response=await this.recover(query.requestId);
        if(response?.data || (response?.saveId && response.fault!=='OUTCOME_UNKNOWN'))return {response,seed:''};
      }
      if (!(error instanceof CdpError) || !['CDP_TIMEOUT','CDP_UNREACHABLE','SESSION_CHANGED'].includes(error.code) || !read)throw error;
      if(query.cursor)return {response:{fault:'SESSION_CHANGED',inGame:null} as Result,seed:''};
    }
    // The retry checks the save inside the same renderer call as the read.
    return remember(await this.#dispatchOnce(guarded));
  }

  async recover(requestId:string):Promise<Result|undefined>{
    const entry=this.#uncertain.get(requestId);
    if(!entry)return;
    try{
      const {response}=await this.#dispatchOnce({tool:'game',query:{},view:'receipt',lookup:true,journalKey:entry.key,saveId:entry.saveId});
      if(response.data || (response.saveId && response.fault!=='OUTCOME_UNKNOWN'))this.#uncertain.delete(requestId);
      return response;
    }catch{return;}
  }

  async #dispatchOnce(command: Command & { connection?: string }) {
    const connection = await this.#get();
    if (command.tool === 'screenshot') {
      return { response: await this.#capture(connection, command), seed: connection.seed };
    }
    const { connection: previous, ...input } = command;
    const isWrite = command.tool === 'game' &&
      (['place','remove','route','wire','configure','upgrade','save','restoreTiles','applyBelts'].includes(input.query.op ?? '') ||
       (input.query.op === 'blueprint' && input.query.blueprintMode === 'paste') || input.query.op==='view' || (input.query.op==='layer' && !!input.query.layer));
    let reply: Reply;
    try {
      reply = await connection.send('Runtime.callFunctionOn', {
        objectId: connection.dispatcher, functionDeclaration: 'function (command) { return this(command); }',
        arguments: [{ value: { ...input, previousConnection: previous !== undefined && previous !== connection.seed } }],
        returnByValue: true, silent: true,
      });
    } catch (error) {
      if (isWrite) throw new CdpError('OUTCOME_UNKNOWN');
      throw error;
    }
    const { result, exceptionDetails } = reply;
    if (exceptionDetails || !result?.value) {
      connection.close();
      throw new CdpError(isWrite ? 'OUTCOME_UNKNOWN' : 'SESSION_CHANGED');
    }
    const response = result.value as Result;
    if (response.fault === 'SESSION_CHANGED' && response.inGame === null) connection.close();
    return { response, seed: connection.seed };
  }

  async #capture(connection: Connection, command: Command): Promise<Result> {
    if (connection.onDebugEvent) return { fault: 'BUSY', inGame: null };
    const marker = 'shapezCapture_' + randomBytes(12).toString('hex');
    let held = false;
    let interrupted = false;
    let debuggerEnabled = false;
    let notify!: (result: 'held' | 'foreign') => void;
    const paused = new Promise<'held' | 'foreign'>(resolve => { notify = resolve; });
    connection.onDebugEvent = (method, name) => {
      if (method === 'Debugger.resumed') { if (held) interrupted = true; held = false; }
      else {
        if (held) interrupted = true;
        held = name === marker;
        notify(held ? 'held' : 'foreign');
      }
    };
    try {
      const ready = await connection.send('Runtime.callFunctionOn', {
        objectId: connection.dispatcher, functionDeclaration: waitForGameFrame.toString(),
        arguments: [{ value: command }], awaitPromise: true, returnByValue: true, silent: true,
      });
      const frame = ready.result?.value as Result | undefined;
      if (!frame?.data) return frame?.fault ? frame : { fault: 'CAPTURE_FAILED', inGame: null };
      await connection.send('Debugger.enable');
      debuggerEnabled = true;
      const execution = connection.send('Runtime.callFunctionOn', {
        objectId: connection.dispatcher,
        functionDeclaration: holdGameFrame.toString().replace('function holdGameFrame(', 'function ' + marker + '('),
        arguments: [{ value: command }, { value: frame.data.epoch }], returnByValue: true,
      });
      const event = await Promise.race([paused, execution]);
      if (event === 'foreign') return { fault: 'BUSY', inGame: null };
      if (event !== 'held') {
        const result = (event as { result?: { value?: Result } }).result?.value;
        if (result?.fault) return result;
        // 未能在暂停点抓帧（例如窗口不可见）时，直接复制合成器当前画面。
        const direct = await connection.send('Page.captureScreenshot', { format: 'png' });
        const directPng = direct.data;
        if (!directPng) return { fault: 'CAPTURE_FAILED', inGame: true };
        const directGuard = await connection.send('Runtime.callFunctionOn', {
          objectId: connection.dispatcher, functionDeclaration: 'function(command) { return this(command); }',
          arguments: [{ value: command }], returnByValue: true, silent: true,
        });
        const guarded = directGuard.result?.value as Result | undefined;
        if (guarded?.fault) return guarded;
        if (guarded?.data?.epoch !== frame.data.epoch) return { fault: 'SESSION_CHANGED', inGame: null };
        const scaled = await connection.send('Runtime.callFunctionOn', {
          objectId: connection.dispatcher, functionDeclaration: scaleCapturedPng.toString(),
          arguments: [{ value: directPng }], awaitPromise: true, returnByValue: true, silent: true,
        });
        const scaledResult = scaled.result?.value as Result | undefined;
        if (scaledResult?.image) return scaledResult;
        return scaledResult?.fault ? scaledResult : { fault: 'CAPTURE_FAILED', inGame: true };
      }
      // Chrome 96 can copy the native view while JS is paused. A surface capture waits for JS.
      let png: string | undefined;
      try {
        png = (await connection.send('Page.captureScreenshot', { format: 'png', fromSurface: false })).data;
      } finally {
        if (held) {
          held = false;
          await connection.send('Debugger.resume');
        }
      }
      const checked = (await execution).result?.value as Result | undefined;
      if (checked?.fault) return checked;
      if (interrupted || checked?.data?.epoch !== frame.data.epoch) return { fault: 'SESSION_CHANGED', inGame: null };
      if (!png || png.length > 32 * 1024 * 1024) return { fault: 'CAPTURE_FAILED', inGame: true };
      const resized = await connection.send('Runtime.callFunctionOn', {
        objectId: connection.dispatcher, functionDeclaration: scaleCapturedPng.toString(),
        arguments: [{ value: png }], awaitPromise: true, returnByValue: true, silent: true,
      });
      const result = resized.result?.value as Result | undefined;
      if (!result?.image) return result?.fault ? result : { fault: 'CAPTURE_FAILED', inGame: true };
      const finalGuard = await connection.send('Runtime.callFunctionOn', {
        objectId: connection.dispatcher, functionDeclaration: 'function(command) { return this(command); }',
        arguments: [{ value: command }], returnByValue: true, silent: true,
      });
      const final = finalGuard.result?.value as Result | undefined;
      if (final?.fault) return final;
      return final?.data?.epoch === frame.data.epoch ? result : { fault: 'SESSION_CHANGED', inGame: null };
    } finally {
      try {
        if (debuggerEnabled && connection.open) await connection.send('Debugger.disable');
      } finally {
        connection.onDebugEvent = undefined;
      }
    }
  }
}
