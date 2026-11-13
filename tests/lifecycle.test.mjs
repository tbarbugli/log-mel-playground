import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMelFilterBank } from '../dist/dsp.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}

function fixture({pendingClose = false} = {}) {
  const elements = new Map(), contexts = [], permission = deferred();
  function node() {
    return {
      style: {}, classList: {add() {}, remove() {}},
      addEventListener() {}, querySelectorAll: () => [],
      getContext: () => ({createImageData: (w, h) => ({data: new Uint8ClampedArray(w*h*4)}), putImageData() {}, drawImage() {}}),
      getBoundingClientRect: () => ({top: 0, height: 300}),
      connect(other) {return other;}, disconnect() {}, start() {}, stop() {},
      gain: {value: 0}, frequency: {value: 0},
    };
  }
  function element(id) {if (!elements.has(id)) elements.set(id, node()); return elements.get(id);}
  class AudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.audioWorklet = {addModule: async () => {}};
      this.closed = deferred();
      contexts.push(this);
    }
    addEventListener() {}
    createGain() {return node();}
    createOscillator() {return node();}
    createMediaStreamSource() {return node();}
    async resume() {this.state = 'running';}
    close() {this.state = 'closed'; return pendingClose ? this.closed.promise : Promise.resolve();}
  }
  class AudioWorkletNode {
    port = {postMessage() {}, close() {}};
    connect(other) {return other;}
    disconnect() {}
    addEventListener() {}
  }
  const sandbox = vm.createContext({
    document: {getElementById: element, createElement: node, querySelector: element, querySelectorAll: () => []},
    navigator: {mediaDevices: {getUserMedia: () => permission.promise}},
    AudioContext, AudioWorkletNode, createMelFilterBank, URL, performance,
    requestAnimationFrame() {}, setInterval: () => 1, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
    window: {addEventListener() {}},
  });
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*/m, '').replaceAll('import.meta.url', '"http://localhost/app.js"');
  vm.runInContext(source, sandbox);
  return {run: code => vm.runInContext(code, sandbox), permission, contexts, element};
}

test('canceling a pending microphone request releases a late permission result', async () => {
  const f = fixture();
  const start = f.run('startCapture("mic")');
  await f.run('stopCapture()');
  let stopped = 0;
  f.permission.resolve({getTracks: () => [{stop() {stopped++;}}]});
  await start;
  assert.equal(stopped, 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.run('running'), false);
});

test('an old asynchronous close cannot erase a newly started demo session', async () => {
  const f = fixture({pendingClose: true});
  await f.run('startCapture("demo")');
  const first = f.contexts[0];
  const stopping = f.run('stopCapture()');
  await f.run('startCapture("demo")');
  assert.equal(f.contexts.length, 2);
  first.closed.resolve();
  await stopping;
  assert.equal(f.run('audioContext'), f.contexts[1]);
  assert.equal(f.run('running'), true);
  assert.equal(f.element('liveStatus').textContent, 'DEMO SIGNAL');
});

test('denied microphone permission produces a usable idle state', async () => {
  const f = fixture();
  const start = f.run('startCapture("mic")');
  f.permission.reject(Object.assign(new Error('denied'), {name: 'NotAllowedError'}));
  await start;
  assert.equal(f.run('running'), false);
  assert.equal(f.run('starting'), false);
  assert.equal(f.contexts.length, 0);
  assert.match(f.element('toast').textContent, /permission was denied/i);
});
