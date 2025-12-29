import { GUI } from 'lil-gui';
import { VisualizerApp } from './VisualizerApp.js';
import { deepMerge } from './core/deepMerge.js';

const canvas = document.getElementById('c');

/**
 * Create the visualizer app (this is the main export you'll reuse in your project).
 *
 * You can pass your own params patch here, or call app.setParams() later.
 */
const app = new VisualizerApp(canvas, {
  preset: 'neonRings'
});

// ------------------------------------
// Minimal demo UI (optional)
// ------------------------------------
const presetSelect = document.getElementById('presetSelect');
const fileInput = document.getElementById('fileInput');
const playPause = document.getElementById('playPause');
const micToggle = document.getElementById('micToggle');

const presets = app.getPresets();
for (const p of presets) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.label;
  presetSelect.appendChild(opt);
}
presetSelect.value = app.getParams().preset;

presetSelect.addEventListener('change', () => {
  app.setPreset(presetSelect.value);
});

// audio element (demo)
const audioEl = new Audio();
audioEl.loop = true;
audioEl.crossOrigin = 'anonymous';
audioEl.preload = 'auto';

// Connect on first user action
let audioConnected = false;
async function ensureAudioConnected() {
  if (audioConnected) return;
  await app.setAudioElement(audioEl);
  audioConnected = true;
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  audioEl.src = url;

  await ensureAudioConnected();
  await audioEl.play();
});

playPause.addEventListener('click', async () => {
  await ensureAudioConnected();
  if (audioEl.paused) {
    await audioEl.play();
  } else {
    audioEl.pause();
  }
});

let micStream = null;
micToggle.addEventListener('click', async () => {
  if (micStream) {
    // stop mic
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
    micToggle.textContent = 'Mic';
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await app.setMicStream(micStream);
    micToggle.textContent = 'Mic On';
  } catch (e) {
    console.error(e);
    alert('Microphone permission denied or unavailable.');
  }
});

// Keyboard shortcuts: 1-3 presets
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable)) return;

  if (e.key === '1') app.setPreset('neonRings');
  if (e.key === '2') app.setPreset('chromeGrid');
  if (e.key === '3') app.setPreset('particles');

  if (e.key.toLowerCase() === 'g') toggleGui();
});

// Keep dropdown in sync
app.on('preset', ({ id }) => {
  presetSelect.value = id;
});

// ------------------------------------
// Optional: lil-gui generated from schema
// (this demonstrates the intended UI hook pattern)
// ------------------------------------
let gui = null;
let guiVisible = true;

function objAtPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const k of parts) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function createGui() {
  const state = app.getParams();
  gui = new GUI({ title: 'Visualizer Params' });
  gui.domElement.style.position = 'fixed';
  gui.domElement.style.right = '14px';
  gui.domElement.style.top = '14px';
  gui.domElement.style.zIndex = '10';

  const schema = app.getParamSchema();
  const folders = new Map();

  const folderFor = (group) => {
    if (!folders.has(group)) {
      folders.set(group, gui.addFolder(group));
    }
    return folders.get(group);
  };

  for (const d of schema) {
    const folder = folderFor(d.group || 'Params');

    const parts = d.path.split('.');
    const key = parts.pop();
    const parentPath = parts.join('.');
    const parent = objAtPath(state, parentPath);

    let controller = null;
    if (d.type === 'number') {
      controller = folder.add(parent, key, d.min, d.max, d.step);
    } else if (d.type === 'boolean') {
      controller = folder.add(parent, key);
    } else if (d.type === 'color') {
      controller = folder.addColor(parent, key);
    } else if (d.type === 'select') {
      controller = folder.add(parent, key, d.options);
    }

    if (controller) {
      controller.name(d.label || key);
      controller.onChange((v) => app.setParam(d.path, v));
    }
  }

  // keep gui state synced when params are changed externally
  app.on('params', ({ patch }) => {
    deepMerge(state, patch);
    gui.controllersRecursive().forEach(c => c.updateDisplay());
  });

  return gui;
}

function toggleGui() {
  if (!gui) gui = createGui();
  guiVisible = !guiVisible;
  gui.domElement.style.display = guiVisible ? 'block' : 'none';
}

// start with gui hidden on mobile widths
if (window.matchMedia('(max-width: 820px)').matches) {
  if (!gui) gui = createGui();
  guiVisible = false;
  gui.domElement.style.display = 'none';
}

// Ensure proper initial sizing
app.resize();

// expose for debugging
window.__app = app;
