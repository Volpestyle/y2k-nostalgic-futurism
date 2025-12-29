/**
 * AudioAnalyzer: WebAudio wrapper that produces per-frame analysis data.
 *
 * Designed to be UI-framework-agnostic:
 * - you can connect an <audio> element, a microphone MediaStream, or a custom AudioNode chain.
 * - call analyzer.update() per render frame to refresh analysis arrays + summary features.
 */
export class AudioAnalyzer {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;

    /** @type {AnalyserNode|null} */
    this.analyser = null;

    /** @type {GainNode|null} */
    this.gain = null;

    /** @type {AudioNode|null} */
    this.source = null;

    this.params = {
      fftSize: 2048,
      smoothingTimeConstant: 0.82,
      gain: 1.0
    };

    /** @type {Uint8Array} */
    this.freqData = new Uint8Array(Math.floor(this.params.fftSize / 2));

    /** @type {Uint8Array} */
    this.timeData = new Uint8Array(this.params.fftSize);

    this.frame = {
      level: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      peak: 0,
      beat: 0 // 0..1 pulse-ish
    };

    // beat-ish tracking (very lightweight, not BPM-accurate)
    this._beatHold = 0;
  }

  /**
   * Ensure AudioContext exists.
   * @returns {AudioContext}
   */
  _ensureContext() {
    if (this.context) return this.context;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.context = new Ctx();
    return this.context;
  }

  /**
   * Apply params to analyser/gain if created.
   */
  _applyParams() {
    if (this.analyser) {
      this.analyser.fftSize = this.params.fftSize;
      this.analyser.smoothingTimeConstant = this.params.smoothingTimeConstant;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyser.fftSize);
    }
    if (this.gain) {
      this.gain.gain.value = this.params.gain;
    }
  }

  /**
   * Update analyzer params (fftSize, smoothingTimeConstant, gain).
   * @param {Partial<typeof this.params>} patch
   */
  setParams(patch) {
    Object.assign(this.params, patch);
    this._applyParams();
    if (!this.analyser) {
      this.freqData = new Uint8Array(Math.floor(this.params.fftSize / 2));
      this.timeData = new Uint8Array(this.params.fftSize);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async resume() {
    const ctx = this._ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /**
   * Disconnect and clear nodes.
   */
  disconnect() {
    try { this.source?.disconnect(); } catch {}
    try { this.analyser?.disconnect(); } catch {}
    try { this.gain?.disconnect(); } catch {}
    this.source = null;
    this.analyser = null;
    this.gain = null;
    this.freqData = new Uint8Array(0);
    this.timeData = new Uint8Array(0);
  }

  /**
   * Connect an <audio> element as the audio source.
   * Note: Must be triggered by a user gesture in most browsers.
   * @param {HTMLAudioElement} audioEl
   */
  connectToAudioElement(audioEl) {
    const ctx = this._ensureContext();
    this.disconnect();

    this.analyser = ctx.createAnalyser();
    this.gain = ctx.createGain();

    // Creating multiple MediaElementAudioSourceNodes for the same element throws.
    // So, if you re-connect the same element, prefer keeping a reference upstream.
    const source = ctx.createMediaElementSource(audioEl);
    this.source = source;

    source.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this._applyParams();
  }

  /**
   * Connect a MediaStream (e.g. microphone) as the audio source.
   * @param {MediaStream} stream
   */
  connectToStream(stream) {
    const ctx = this._ensureContext();
    this.disconnect();

    this.analyser = ctx.createAnalyser();
    this.gain = ctx.createGain();

    const source = ctx.createMediaStreamSource(stream);
    this.source = source;

    source.connect(this.gain);
    this.gain.connect(this.analyser);
    // for mic we *don't* connect to destination by default (avoid echo)
    // If you want monitoring, connect gain -> destination yourself.

    this._applyParams();
  }

  /**
   * Connect a custom AudioNode as source.
   * Useful if you already have a WebAudio graph.
   * @param {AudioNode} node
   * @param {AudioContext} context
   * @param {{monitor?: boolean}} [opts]
   */
  connectToNode(node, context, opts = {}) {
    this.context = context;
    this.disconnect();

    this.analyser = context.createAnalyser();
    this.gain = context.createGain();
    this.source = node;

    node.connect(this.gain);
    this.gain.connect(this.analyser);
    if (opts.monitor) {
      this.analyser.connect(context.destination);
    }

    this._applyParams();
  }

  /**
   * Call once per render frame to refresh analysis arrays + summary values.
   * @returns {{freqData: Uint8Array, timeData: Uint8Array, frame: typeof this.frame}}
   */
  update() {
    if (!this.analyser) return { freqData: this.freqData, timeData: this.timeData, frame: this.frame };

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    // RMS level (0..1)
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.timeData.length); // 0..~1
    const level = Math.min(1, rms * 1.8);

    // simple band energies: bass (0..10%), mid (10..40%), treble (40..100%)
    const n = this.freqData.length || 1;
    const bassEnd = Math.max(1, Math.floor(n * 0.10));
    const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.40));

    let bass = 0, mid = 0, treble = 0;
    for (let i = 0; i < bassEnd; i++) bass += this.freqData[i];
    for (let i = bassEnd; i < midEnd; i++) mid += this.freqData[i];
    for (let i = midEnd; i < n; i++) treble += this.freqData[i];

    bass = (bass / bassEnd) / 255;
    mid = (mid / (midEnd - bassEnd)) / 255;
    treble = (treble / (n - midEnd)) / 255;

    // peak + beat-ish: detect rising bass energy
    const peak = Math.max(this.frame.peak * 0.94, level);
    const bassRise = Math.max(0, bass - (this.frame.bass || 0));
    const hit = Math.min(1, bassRise * 3.0 + (bass - 0.55) * 0.9);

    this._beatHold = Math.max(this._beatHold * 0.86, hit);
    const beat = this._beatHold;

    this.frame.level = level;
    this.frame.bass = bass;
    this.frame.mid = mid;
    this.frame.treble = treble;
    this.frame.peak = peak;
    this.frame.beat = beat;

    return { freqData: this.freqData, timeData: this.timeData, frame: this.frame };
  }
}
