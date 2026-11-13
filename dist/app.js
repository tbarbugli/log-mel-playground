import { createMelFilterBank } from "./dsp.js";

const FFT_SIZE = 2048;
const MEL_BINS = 64;
const WINDOW_SECONDS = 3;
const HISTORY_FRAMES = 300;
const $ = (id) => document.getElementById(id);
const canvas = $("spectrogram");
const ctx = canvas.getContext("2d", { alpha: false });
const bufferCanvas = document.createElement("canvas");
bufferCanvas.width = HISTORY_FRAMES;
bufferCanvas.height = MEL_BINS;
const bufferContext = bufferCanvas.getContext("2d");
const image = bufferContext.createImageData(HISTORY_FRAMES, MEL_BINS);
const emptyState = $("emptyState");
const frames = Array.from({ length: HISTORY_FRAMES }, () => new Float32Array(MEL_BINS).fill(-120));
let writeIndex = 0;
let frameCount = 0;
let audioContext = null;
let worklet = null;
let source = null;
let mediaStream = null;
let oscillator = null;
let harmonic = null;
let demoGain = null;
let sourceKind = "mic";
let running = false;
let starting = false;
let startToken = 0;
let frozen = false;
let startedAt = 0;
let elapsedTimer = 0;
let frameTimes = [];
let toastTimer = 0;
let dynamicRange = 72;
let displayGain = 1;
let melConfig = null;
let lastRms = 0;

const palette = [
  [7, 17, 30], [9, 38, 57], [10, 73, 98], [17, 133, 153],
  [35, 207, 197], [116, 231, 162], [201, 246, 108], [248, 255, 190],
];

function colorAt(t) {
  const p = Math.max(0, Math.min(0.999999, t)) * (palette.length - 1);
  const i = Math.floor(p);
  const f = p - i;
  const a = palette[i];
  const b = palette[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f), 255];
}

let renderPending = false;
function render() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    paint();
  });
}

function paint() {
  const gainDb = 20 * Math.log10(displayGain);
  for (let x = 0; x < HISTORY_FRAMES; x += 1) {
    const relative = (x - (HISTORY_FRAMES - frameCount)) % HISTORY_FRAMES;
    const frame = relative >= 0 ? frames[(writeIndex - frameCount + relative + HISTORY_FRAMES) % HISTORY_FRAMES] : null;
    for (let y = 0; y < MEL_BINS; y += 1) {
      const band = MEL_BINS - 1 - y;
      const db = frame ? frame[band] + gainDb : -120;
      const rgba = colorAt(Math.max(0, Math.min(1, (db + dynamicRange) / dynamicRange)));
      const offset = (y * HISTORY_FRAMES + x) * 4;
      image.data[offset] = rgba[0]; image.data[offset + 1] = rgba[1]; image.data[offset + 2] = rgba[2]; image.data[offset + 3] = 255;
    }
  }
  bufferContext.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bufferCanvas, 0, 0, canvas.width, canvas.height);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
}

function formatFrequency(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}

function updateFrequencyAxis(minHz = 50, maxHz = 8000) {
  const lowMel = 2595 * Math.log10(1 + minHz / 700);
  const highMel = 2595 * Math.log10(1 + maxHz / 700);
  for (const label of document.querySelectorAll(".freq-label")) {
    const hz = Number(label.dataset.hz);
    label.hidden = hz < minHz || hz > maxHz;
    if (!label.hidden) {
      const mel = 2595 * Math.log10(1 + hz / 700);
      label.style.top = `${100 * (1 - (mel - lowMel) / (highMel - lowMel))}%`;
    }
  }
}

function updateMetrics(values, rms) {
  const power = values.map((db) => 10 ** (db / 10));
  let total = 0;
  let weighted = 0;
  let peakIndex = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += power[i];
    weighted += power[i] * melConfig.centersHz[i];
    if (values[i] > values[peakIndex]) peakIndex = i;
  }
  $("peakValue").innerHTML = `${formatFrequency(melConfig.centersHz[peakIndex])} <small>Hz</small>`;
  $("centroidValue").innerHTML = `${formatFrequency(total > 0 ? weighted / total : 0)} <small>Hz</small>`;
  lastRms = rms;
  const dbfs = 20 * Math.log10(Math.max(rms, 1e-6));
  $("levelValue").innerHTML = `${Math.max(-120, dbfs).toFixed(1)} <small>dBFS</small>`;
  $("levelBar").style.width = `${Math.max(0, Math.min(100, (dbfs + 60) / 60 * 100))}%`;
}

function onWorkletMessage({ data }) {
  if (data.type === "ready") {
    if (!audioContext) return;
    $("captureLabel").textContent = `${audioContext.sampleRate.toLocaleString()} Hz · ${FFT_SIZE} pt FFT · ${MEL_BINS} Mel bands`;
    $("rateValue").textContent = (audioContext.sampleRate / data.hopSize).toFixed(0);
    updateFrequencyAxis(melConfig.minHz, melConfig.maxHz);
    return;
  }
  if (data.type !== "frame") return;
  if (frozen) return;
  const values = data.values;
  frames[writeIndex].set(values);
  writeIndex = (writeIndex + 1) % HISTORY_FRAMES;
  frameCount = Math.min(frameCount + 1, HISTORY_FRAMES);
  updateMetrics(values, data.rms);
  frameTimes.push(performance.now());
  const now = performance.now();
  frameTimes = frameTimes.filter((time) => now - time < 1000);
  $("rateValue").textContent = String(frameTimes.length);
  emptyState.classList.add("hidden");
  render();
}

function resetView() {
  writeIndex = 0;
  frameCount = 0;
  for (const frame of frames) frame.fill(-120);
  $("peakValue").innerHTML = "— <small>Hz</small>";
  $("centroidValue").innerHTML = "— <small>Hz</small>";
  $("levelValue").innerHTML = "— <small>dBFS</small>";
  $("levelBar").style.width = "0%";
  frameTimes = [];
  render();
}

function setRunningUi(kind) {
  running = true;
  frozen = false;
  sourceKind = kind;
  $("liveDot").className = "live-dot active";
  $("liveStatus").textContent = kind === "demo" ? "DEMO SIGNAL" : "MICROPHONE LIVE";
  $("startButton").innerHTML = '<span class="mic-icon">■</span><span>Stop capture</span>';
  $("freezeButton").disabled = false;
  $("freezeButton").innerHTML = '<span class="freeze-icon">Ⅱ</span><span>Freeze</span>';
  $("captureLabel").textContent = kind === "demo" ? "Synthetic tone · 220 Hz + swept harmonic" : "Microphone input";
  $("demoButton").innerHTML = kind === "demo" ? '<span class="play-icon">■</span> Stop demo' : '<span class="play-icon">▶</span> Switch to demo';
  startedAt = performance.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const seconds = (performance.now() - startedAt) / 1000;
    $("elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${Math.floor(seconds * 10) % 10}`;
  }, 100);
}

async function startCapture(kind) {
  const token = ++startToken;
  if (running || audioContext || mediaStream) await stopCapture(false);
  if (token !== startToken) return;
  resetView();
  starting = true;
  $("startButton").innerHTML = '<span class="mic-icon">…</span><span>Cancel startup</span>';
  try {
    if (kind === "mic") {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture needs a secure browser context (HTTPS or localhost).");
      const requestedStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (token !== startToken) { for (const track of requestedStream.getTracks()) track.stop(); return; }
      mediaStream = requestedStream;
    }
    audioContext = new AudioContext({ latencyHint: "interactive" });
    const context = audioContext;
    if (context.state !== "running") await context.resume();
    if (token !== startToken) { if (context.state !== "closed") await context.close().catch(() => {}); return; }
    await context.audioWorklet.addModule(new URL("./log-mel-processor.js", import.meta.url));
    if (token !== startToken) { if (context.state !== "closed") await context.close().catch(() => {}); return; }
    melConfig = createMelFilterBank({ sampleRate: audioContext.sampleRate, fftSize: FFT_SIZE, melBins: MEL_BINS, minHz: 50, maxHz: 8000 });
    const serializedConfig = { ...melConfig, centersHz: Array.from(melConfig.centersHz), window: Array.from(melConfig.window), filters: melConfig.filters.map((weights) => Array.from(weights)) };
    worklet = new AudioWorkletNode(audioContext, "log-mel-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
    worklet.port.onmessage = (event) => { if (token === startToken) onWorkletMessage(event); };
    worklet.port.postMessage({ type: "configure", fftSize: FFT_SIZE, config: serializedConfig });
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    worklet.connect(silentGain).connect(audioContext.destination);
    if (kind === "mic") {
      source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(worklet);
      for (const track of mediaStream.getAudioTracks()) track.addEventListener("ended", () => { if (running && token === startToken) { showToast("Microphone input ended."); stopCapture(); } }, { once: true });
    } else {
      oscillator = audioContext.createOscillator();
      harmonic = audioContext.createOscillator();
      demoGain = audioContext.createGain();
      oscillator.type = "sine"; oscillator.frequency.value = 220;
      harmonic.type = "sawtooth"; harmonic.frequency.value = 900;
      const oscillatorLfo = audioContext.createOscillator();
      const lfoGain = audioContext.createGain();
      oscillatorLfo.frequency.value = 0.075; lfoGain.gain.value = 600;
      oscillatorLfo.connect(lfoGain).connect(harmonic.frequency);
      oscillatorLfo.start();
      demoGain.gain.value = 0.11;
      oscillator.connect(demoGain); harmonic.connect(demoGain); demoGain.connect(worklet);
      oscillator.start(); harmonic.start();
      window._demoLfo = oscillatorLfo;
    }
    if (token !== startToken) { await stopCapture(false); return; }
    starting = false;
    setRunningUi(kind);
    context.addEventListener("statechange", () => {
      if (token !== startToken || !running) return;
      if (context.state === "running") {
        $("liveDot").className = frozen ? "live-dot paused" : "live-dot active";
        $("liveStatus").textContent = frozen ? "FROZEN FRAME" : sourceKind === "demo" ? "DEMO SIGNAL" : "MICROPHONE LIVE";
      } else if (context.state === "suspended" || context.state === "interrupted") {
        $("liveDot").className = "live-dot paused";
        $("liveStatus").textContent = "AUDIO SUSPENDED";
      }
    });
  } catch (error) {
    if (token !== startToken) return;
    if (mediaStream) { for (const track of mediaStream.getTracks()) track.stop(); mediaStream = null; }
    const failedContext = audioContext;
    audioContext = null;
    worklet = null; source = null; running = false; starting = false;
    $("liveDot").className = "live-dot"; $("liveStatus").textContent = "STANDING BY";
    $("captureLabel").textContent = "Awaiting signal";
    $("startButton").innerHTML = '<span class="mic-icon">●</span><span>Start microphone</span>';
    $("freezeButton").disabled = true;
    $("elapsed").textContent = "00:00.0";
    if (failedContext && failedContext.state !== "closed") await failedContext.close().catch(() => {});
    if (token !== startToken) return;
    const message = error.name === "NotAllowedError" ? "Microphone permission was denied. Allow access in your browser settings and try again." : error.message || "Unable to start audio capture.";
    showToast(message);
    emptyState.classList.remove("hidden");
  }
}

async function stopCapture(invalidateStart = true) {
  if (invalidateStart) startToken += 1;
  running = false;
  starting = false;
  frozen = false;
  clearInterval(elapsedTimer);
  if (source) { try { source.disconnect(); } catch {} source = null; }
  if (worklet) { try { worklet.disconnect(); worklet.port.close(); } catch {} worklet = null; }
  if (oscillator) { try { oscillator.stop(); oscillator.disconnect(); } catch {} oscillator = null; }
  if (harmonic) { try { harmonic.stop(); harmonic.disconnect(); } catch {} harmonic = null; }
  if (window._demoLfo) { try { window._demoLfo.stop(); window._demoLfo.disconnect(); } catch {} window._demoLfo = null; }
  if (demoGain) { try { demoGain.disconnect(); } catch {} demoGain = null; }
  if (mediaStream) { for (const track of mediaStream.getTracks()) track.stop(); mediaStream = null; }
  const closingContext = audioContext;
  audioContext = null;
  $("liveDot").className = "live-dot";
  $("liveStatus").textContent = frameCount ? "CAPTURE STOPPED" : "STANDING BY";
  $("startButton").innerHTML = '<span class="mic-icon">●</span><span>Start microphone</span>';
  $("freezeButton").disabled = true;
  $("freezeButton").innerHTML = '<span class="freeze-icon">Ⅱ</span><span>Freeze</span>';
  $("demoButton").innerHTML = '<span class="play-icon">▶</span> Try a demo signal';
  $("captureLabel").textContent = frameCount ? "Last frame retained" : "Awaiting signal";
  $("rateValue").textContent = "—";
  if (closingContext && closingContext.state !== "closed") await closingContext.close().catch(() => {});
}

function updateRangeTrack(input, min, max, value, color) {
  const pct = ((value - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(90deg,${color} 0%,${color} ${pct}%,#263748 ${pct}%)`;
}

$("startButton").addEventListener("click", () => running || starting ? stopCapture() : startCapture("mic"));
$("demoButton").addEventListener("click", () => running && sourceKind === "demo" ? stopCapture() : startCapture("demo"));
$("demoInline").addEventListener("click", () => startCapture("demo"));
$("freezeButton").addEventListener("click", () => {
  if (!running) return;
  frozen = !frozen;
  $("liveStatus").textContent = frozen ? "FROZEN FRAME" : sourceKind === "demo" ? "DEMO SIGNAL" : "MICROPHONE LIVE";
  $("liveDot").className = frozen ? "live-dot paused" : "live-dot active";
  $("freezeButton").innerHTML = frozen ? '<span class="freeze-icon">▶</span><span>Resume</span>' : '<span class="freeze-icon">Ⅱ</span><span>Freeze</span>';
});
$("rangeSlider").addEventListener("input", (event) => {
  dynamicRange = Number(event.target.value);
  $("rangeValue").textContent = String(dynamicRange);
  $("dbFloor").textContent = `−${dynamicRange}`;
  updateRangeTrack(event.target, 36, 96, dynamicRange, "var(--cyan)");
  render();
});
$("gainSlider").addEventListener("input", (event) => {
  displayGain = Number(event.target.value);
  $("gainValue").textContent = displayGain.toFixed(1);
  updateRangeTrack(event.target, 0.5, 2, displayGain, "var(--lime)");
  render();
});
const dialog = $("aboutDialog");
$("aboutButton").addEventListener("click", () => dialog.showModal());
$("dialogClose").addEventListener("click", () => dialog.close());
$("dialogOk").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
const crosshair = $("crosshair");
const plotWrap = document.querySelector(".plot-wrap");
plotWrap.addEventListener("pointermove", (event) => {
  const rect = plotWrap.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const minHz = melConfig?.minHz ?? 50;
  const maxHz = melConfig?.maxHz ?? 8000;
  const lowMel = 2595 * Math.log10(1 + minHz / 700);
  const highMel = 2595 * Math.log10(1 + maxHz / 700);
  const mel = highMel - (y / rect.height) * (highMel - lowMel);
  const hz = 700 * (10 ** (mel / 2595) - 1);
  crosshair.style.display = "block";
  crosshair.style.top = `${y}px`;
  $("crosshairValue").textContent = `${formatFrequency(hz)} Hz`;
});
plotWrap.addEventListener("pointerleave", () => { crosshair.style.display = "none"; });
$("windowLabel").textContent = `${WINDOW_SECONDS.toFixed(2)} S WINDOW`;
updateRangeTrack($("rangeSlider"), 36, 96, dynamicRange, "var(--cyan)");
updateRangeTrack($("gainSlider"), 0.5, 2, displayGain, "var(--lime)");
updateFrequencyAxis();
render();
