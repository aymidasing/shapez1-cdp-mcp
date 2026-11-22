import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameConnection } from '../dist/cdp.mjs';

test('a dropped dispatch retries an independent read once and never repeats a write', async t => {
  const id = 'a'.repeat(32);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => [{ id, type: 'page',
      url: 'file:///steam/shapez.io/resources/app.asar/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/' + id }],
  }));
  const sent = [];
  let dropNext = true;
  let journal,activeId='factory-A';
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
    send(message) {
      const { id, method, params } = JSON.parse(message);
      let result = {};
      if (method === 'Runtime.queryObjects') assert.fail('unexpected heap scan');
      if (method === 'Runtime.evaluate') result = { result: { objectId: 'app' } };
      if (method === 'Runtime.callFunctionOn') {
        if (params.objectId === 'app') result = { result: { objectId: 'dispatcher' } };
        else {
          const command = params.arguments[0].value;
          sent.push(command.query.op ?? command.tool);
          const response=command.lookup ? (command.journalKey===journal?{data:{placed:1}}:{fault:'OUTCOME_UNKNOWN'}) :
            (command.saveId && activeId!==command.saveId ? {fault:'SAVE_ID_MISMATCH'} : {data:{ok:true},saveId:activeId});
          if (dropNext) {
            journal=command.journalKey;
            dropNext = false;
            queueMicrotask(() => this.close());
            return;
          }
          result = { result: { value: response } };
        }
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id, result }),
      })));
    }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const game = new GameConnection('write');
  try {
    const status = await game.dispatch({ tool: 'status', query: {}, view: 'test' });
    assert.equal(status.response.data.ok, true);
    dropNext = true;
    await assert.rejects(game.dispatch({ tool: 'game', query: { op: 'place' }, view: 'test' }),
      { code: 'OUTCOME_UNKNOWN' });
    assert.deepEqual(sent, ['status', 'status', 'place']);
    dropNext=true;
    const applied=await game.dispatch({tool:'game',view:'keyed',query:{op:'place',requestId:'known-batch-0001'}});
    assert.equal(applied.response.data.placed,1);
    assert.deepEqual(sent.slice(3),['place','game']); // second call is lookup-only
    activeId='factory-B';dropNext=true;
    const switched=await game.dispatch({tool:'game',view:'guard',query:{op:'trace'}});
    assert.equal(switched.response.fault,'SAVE_ID_MISMATCH');
  } finally {
    game.close();
    globalThis.WebSocket = original;
  }
});
