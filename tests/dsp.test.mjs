import test from 'node:test';
import assert from 'node:assert/strict';
import { fftInPlace, hannPeriodic, createMelFilterBank, computeLogMelFrame } from '../dist/dsp.js';

test('FFT agrees with an independent direct DFT, including complex input', () => {
  const n = 32;
  const real = Float64Array.from({length: n}, (_, i) => Math.sin(i * 0.7) + 0.2 * Math.cos(i * 1.2));
  const imag = Float64Array.from({length: n}, (_, i) => Math.cos(i * 0.3) * 0.1);
  const expected = Array.from({length: n}, (_, k) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const angle = -2 * Math.PI * k * i / n;
      re += real[i] * Math.cos(angle) - imag[i] * Math.sin(angle);
      im += real[i] * Math.sin(angle) + imag[i] * Math.cos(angle);
    }
    return [re, im];
  });
  fftInPlace(real, imag);
  expected.forEach(([re, im], k) => {
    assert.ok(Math.abs(real[k] - re) < 1e-10);
    assert.ok(Math.abs(imag[k] - im) < 1e-10);
  });
  assert.throws(() => fftInPlace(new Float32Array(9), new Float32Array(9)), RangeError);
});

test('periodic Hann has the expected coherent and energy gains', () => {
  const w = hannPeriodic(2048);
  assert.equal(w[0], 0);
  assert.equal(w[1024], 1);
  assert.ok(Math.abs(w.reduce((s, x) => s + x, 0) / w.length - 0.5) < 1e-7);
  assert.ok(Math.abs(w.reduce((s, x) => s + x*x, 0) / w.length - 0.375) < 1e-7);
});

test('Mel triangles are nonnegative, bounded and ordered, capped at Nyquist', () => {
  const bank = createMelFilterBank({sampleRate: 12000, fftSize: 2048, melBins: 64});
  assert.equal(bank.maxHz, 6000);
  bank.filters.forEach((weights, m) => {
    assert.equal(weights.length, 1025);
    assert.ok(weights.some(x => x > 0), `empty band ${m}`);
    assert.ok(weights.every(x => x >= 0 && x <= 1));
    if (m) assert.ok(bank.centersHz[m] > bank.centersHz[m-1]);
  });
});

for (const sampleRate of [16000, 44100, 48000]) {
  test(`Log-Mel locates a known tone and preserves power ratios at ${sampleRate} Hz`, () => {
    const bank = createMelFilterBank({sampleRate, fftSize: 2048, melBins: 64});
    const hz = 1000;
    const tone = Float32Array.from({length: bank.fftSize}, (_, i) => 0.25 * Math.sin(2*Math.PI*hz*i/sampleRate));
    const full = computeLogMelFrame(tone, bank);
    const half = computeLogMelFrame(tone.map(x => x*0.5), bank);
    const peak = full.indexOf(Math.max(...full));
    assert.ok(Math.abs(bank.centersHz[peak] - hz) < 100, `peak at ${bank.centersHz[peak]}`);
    assert.ok(Math.abs((full[peak] - half[peak]) - 20*Math.log10(2)) < 1e-4);
    assert.ok(full.every(Number.isFinite));
    const silence = computeLogMelFrame(new Float32Array(bank.fftSize), bank);
    assert.ok(silence.every(x => x === -120));
  });
}
