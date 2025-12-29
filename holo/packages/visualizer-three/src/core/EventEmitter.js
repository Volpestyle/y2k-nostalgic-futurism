/**
 * Tiny event emitter (no deps).
 */
export class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} event
   * @param {(payload:any)=>void} fn
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /**
   * @param {string} event
   * @param {(payload:any)=>void} fn
   */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(fn);
  }

  /**
   * @param {string} event
   * @param {any} payload
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }
}
