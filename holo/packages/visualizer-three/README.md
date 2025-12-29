# Y2K Nostalgic Futurism - Three.js Music Visualizer (Scene + UI Hooks)

This is a small **Three.js** project that gives you:

- A ready-to-run **Three.js scene** (renderer, camera, lights, environment, background)
- **OrbitControls** (drag/orbit/zoom/pan)
- A **music analysis pipeline** (WebAudio AnalyserNode) you can connect to your own audio UI
- Multiple built-in **visualizer variations** (presets) and a **parameter system** designed to plug into *your* UI component library

It ships with a minimal HTML demo UI and an optional **lil-gui** panel generated from the param schema - but the main goal is the `VisualizerApp` API.

---

## Quick start

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

**Controls**
- Drag: orbit
- Scroll: zoom
- Shift+drag / right drag: pan
- Keys `1-3`: switch presets
- Key `G`: toggle lil-gui (optional demo)

---

## The API you'll integrate

### Create the app

```js
import { VisualizerApp } from './src/VisualizerApp.js';

const canvas = document.querySelector('canvas');

const app = new VisualizerApp(canvas, {
  preset: 'neonRings',
  params: {
    post: { bloomStrength: 1.6 }
  }
});
```

### Switch visualizer variations (presets)

```js
app.setPreset('chromeGrid');  // 'neonRings' | 'chromeGrid' | 'particles'
```

### Update many parameters (patch / deep merge)

```js
app.setParams({
  post: {
    bloomStrength: 1.9,
    scanlines: 0.3
  },
  global: {
    camera: { autoRotate: true }
  },
  neonRings: {
    ringCount: 24,
    colorA: '#00e5ff',
    colorB: '#ff4fd8'
  }
});
```

### Update a single parameter (dot-path)

Useful for generic UI builders:

```js
app.setParam('post.bloomStrength', 1.75);
app.setParam('global.background.starDensity', 0.9);
```

### Read params + schema (UI hooks)

```js
const params = app.getParams();           // deep clone
const schema = app.getParamSchema();      // [{path,type,min,max,...}, ...]
const presets = app.getPresets();         // [{id,label}, ...]
```

The schema is meant for building sliders/selects/color pickers in your own UI.

### Subscribe to events

```js
app.on('params', ({ params, patch }) => {
  // patch = the last patch you applied
  // params = full current params (clone)
});

app.on('preset', ({ id }) => {});
app.on('resize', ({ width, height }) => {});
app.on('audio', (info) => {});
```

---

## Hooking up audio

### Option A: connect an `<audio>` element

```js
const audio = new Audio();
audio.src = '/path/to/track.mp3';
audio.loop = true;

await app.setAudioElement(audio); // must be in a user gesture
await audio.play();
```

### Option B: microphone

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
await app.setMicStream(stream);
```

### Option C: your own WebAudio graph

If you already have an AudioContext + nodes, you can connect through `app.audio`:

```js
app.audio.connectToNode(myNode, myAudioContext, { monitor: false });
```

---

## Built-in visualizers

- **Neon Rings (Y2K Halo)** - stacked torus rings pulsing with spectrum
- **Chrome Grid (Retro Wavefield)** - displaced plane with neon wire overlay
- **Particle Orbital (Starburst Core)** - additive glowing particles orbiting with beat

---

## Adding your own variation

Create a class with:

- `init({scene, camera, renderer})`
- `setParams(params)`
- `update(dt, t, audio)` where `audio.frame` has `{ level, bass, mid, treble, beat }`
- `dispose()`

Then register it in `src/VisualizerApp.js` inside `VISUALIZER_REGISTRY` and add a preset in `src/presets.js`.

---

## Notes

- The project is intentionally **UI-framework-agnostic**.
- Post-processing uses **UnrealBloomPass + a scanline/chromatic shader** to push the Y2K aesthetic.
- If performance is low, reduce:
  - `particles.count`
  - `chromeGrid.segments`
  - Bloom strength/radius

---

Have fun - swap the demo UI for your own component library and wire up your track picker + transport controls.
