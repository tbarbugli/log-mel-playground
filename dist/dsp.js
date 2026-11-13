/**
 * Small, dependency-free Log-Mel DSP primitives shared by the browser app and tests.
 * Power is summed through HTK-spaced triangular filters and returned in dB.
 */
export function hannPeriodic(length) {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return window;
}

export function fftInPlace(real, imag) {
  const n = real.length;
  if (n !== imag.length || n < 2 || (n & (n - 1)) !== 0) throw new RangeError("FFT arrays must have equal power-of-two lengths");
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k += 1) {
        const even = start + k;
        const odd = even + half;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        real[odd] = real[even] - tr;
        imag[odd] = imag[even] - ti;
        real[even] += tr;
        imag[even] += ti;
        const nextWr = wr * stepRe - wi * stepIm;
        wi = wr * stepIm + wi * stepRe;
        wr = nextWr;
      }
    }
  }
  return { real, imag };
}

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

export function createMelFilterBank({ sampleRate, fftSize = 1024, melBins = 64, minHz = 50, maxHz = 8000 }) {
  if (!(sampleRate > 0) || !(fftSize >= 2) || (fftSize & (fftSize - 1)) !== 0 || !(melBins > 0)) {
    throw new RangeError("Expected a positive sample rate, power-of-two FFT size, and positive Mel bin count");
  }
  const nyquist = sampleRate / 2;
  const low = Math.max(0, Math.min(minHz, nyquist - Number.EPSILON * nyquist));
  const high = Math.min(maxHz, nyquist);
  if (!(high > low)) throw new RangeError("Mel frequency range must be non-empty and below Nyquist");
  const melLow = hzToMel(low);
  const melHigh = hzToMel(high);
  const edges = new Float64Array(melBins + 2);
  for (let i = 0; i < edges.length; i += 1) edges[i] = melToHz(melLow + ((melHigh - melLow) * i) / (edges.length - 1));
  const bins = new Array(melBins);
  const centersHz = new Float32Array(melBins);
  const binHz = sampleRate / fftSize;
  for (let m = 0; m < melBins; m += 1) {
    const left = edges[m];
    const center = edges[m + 1];
    const right = edges[m + 2];
    centersHz[m] = center;
    const weights = new Float32Array(fftSize / 2 + 1);
    for (let k = 0; k < weights.length; k += 1) {
      const hz = k * binHz;
      if (hz >= left && hz <= center) weights[k] = (hz - left) / Math.max(center - left, 1e-12);
      else if (hz > center && hz <= right) weights[k] = (right - hz) / Math.max(right - center, 1e-12);
    }
    bins[m] = weights;
  }
  return { sampleRate, fftSize, melBins, minHz: low, maxHz: high, binHz, centersHz, filters: bins, window: hannPeriodic(fftSize) };
}

/** Convert one real, window-sized PCM frame to power dB for each Mel band. */
export function computeLogMelFrame(samples, config, out = new Float32Array(config.melBins)) {
  const { fftSize, window, filters, melBins } = config;
  if (samples.length !== fftSize) throw new RangeError(`Expected ${fftSize} PCM samples`);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) real[i] = samples[i] * window[i];
  fftInPlace(real, imag);
  const powers = new Float32Array(fftSize / 2 + 1);
  const scale = 1 / (fftSize * fftSize);
  for (let k = 0; k < powers.length; k += 1) powers[k] = (real[k] * real[k] + imag[k] * imag[k]) * scale;
  for (let m = 0; m < melBins; m += 1) {
    const weights = filters[m];
    let energy = 0;
    for (let k = 0; k < weights.length; k += 1) energy += powers[k] * weights[k];
    out[m] = 10 * Math.log10(Math.max(energy, 1e-12));
  }
  return out;
}
