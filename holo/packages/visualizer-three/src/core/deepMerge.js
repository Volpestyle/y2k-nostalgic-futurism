/**
 * Deep merge helper for plain objects.
 * Arrays are replaced (not merged).
 * @template T
 * @param {T} target
 * @param {Partial<T>} patch
 * @returns {T}
 */
export function deepMerge(target, patch) {
  if (patch == null) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) {
      target[k] = v.slice();
      continue;
    }
    if (v && typeof v === 'object') {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
      continue;
    }
    target[k] = v;
  }
  return target;
}

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function deepClone(obj) {
  return structuredClone ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}
