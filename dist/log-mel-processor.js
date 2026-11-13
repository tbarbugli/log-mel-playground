import { computeLogMelFrame } from "./dsp.js";

class LogMelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.totalSamples = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type !== "configure") return;
      this.fftSize = data.fftSize;
      this.hopSize = Math.max(1, Math.round(sampleRate * 0.01));
      this.config = data.config;
      this.history = new Float32Array(this.fftSize);
      this.cursor = 0;
      this.sinceFrame = 0;
      this.frame = new Float32Array(this.config.melBins);
      this.ready = true;
      this.port.postMessage({ type: "ready", hopSize: this.hopSize, sampleRate });
    };
  }

  process(inputs) {
    if (!this.ready) return true;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channels.length; c += 1) sample += channels[c][i] || 0;
      sample /= channels.length;
      this.history[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % this.fftSize;
      this.totalSamples += 1;
      this.sinceFrame += 1;
      if (this.totalSamples >= this.fftSize && this.sinceFrame >= this.hopSize) {
        this.sinceFrame = 0;
        const ordered = new Float32Array(this.fftSize);
        const first = this.cursor;
        const tail = this.fftSize - first;
        ordered.set(this.history.subarray(first), 0);
        if (first > 0) ordered.set(this.history.subarray(0, first), tail);
        computeLogMelFrame(ordered, this.config, this.frame);
        let squareSum = 0;
        for (let j = 0; j < ordered.length; j += 1) squareSum += ordered[j] * ordered[j];
        const values = this.frame.slice();
        this.port.postMessage({ type: "frame", values, sampleCount: this.totalSamples, rms: Math.sqrt(squareSum / ordered.length) }, [values.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("log-mel-processor", LogMelProcessor);
