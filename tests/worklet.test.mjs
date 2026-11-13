import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMelFilterBank, computeLogMelFrame } from '../dist/dsp.js';

test('worklet frames arbitrary audio blocks at exact sample hops without drift', () => {
  const sampleRate = 44100, fftSize = 2048;
  const config = createMelFilterBank({sampleRate, fftSize, melBins: 64});
  const messages = [];
  let Processor;
  class AudioWorkletProcessor {
    port = {postMessage: data => messages.push(structuredClone(data))};
  }
  const source = readFileSync(new URL('../dist/log-mel-processor.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*/m, '');
  vm.runInNewContext(source, {
    AudioWorkletProcessor, sampleRate, computeLogMelFrame,
    registerProcessor: (_name, klass) => { Processor = klass; },
  });
  const processor = new Processor();
  processor.port.onmessage({data: {type: 'configure', fftSize, config}});
  const samples = Float32Array.from({length: 44100}, (_, i) => 0.25 * Math.sin(2*Math.PI*1000*i/sampleRate));
  for (let i = 0; i < samples.length; i += 128) {
    const block = samples.subarray(i, i + 128);
    assert.equal(processor.process([[block, block]]), true);
  }
  const frames = messages.filter(x => x.type === 'frame');
  const hop = Math.round(sampleRate * 0.01);
  assert.equal(frames.length, 1 + Math.floor((samples.length - fftSize)/hop));
  frames.forEach((frame, i) => {
    assert.equal(frame.sampleCount, fftSize + i*hop);
    assert.equal(frame.values.length, 64);
    assert.ok(frame.values.every(Number.isFinite));
  });
  const direct = computeLogMelFrame(samples.subarray(0, fftSize), config);
  assert.deepEqual(Array.from(frames[0].values), Array.from(direct));
  const expectedRms = Math.sqrt(samples.subarray(0, fftSize).reduce((sum, value) => sum + value*value, 0) / fftSize);
  assert.ok(Math.abs(frames[0].rms - expectedRms) < 1e-10);
});
