/**
 * Param schema intended for building a UI (forms, sliders, selects, color pickers).
 *
 * A descriptor has:
 * - path: dot-path into the params object
 * - type: 'number' | 'boolean' | 'color' | 'select'
 * - label: UI label
 * - group: a logical grouping (tab/section)
 * - min/max/step for numbers
 * - options for selects
 */
export const paramSchema = [
  // Global
  { path: 'global.background.colorTop', type: 'color', label: 'Top', group: 'Background' },
  { path: 'global.background.colorBottom', type: 'color', label: 'Bottom', group: 'Background' },
  { path: 'global.background.starDensity', type: 'number', label: 'Star density', group: 'Background', min: 0, max: 1, step: 0.01 },
  { path: 'global.background.starSpeed', type: 'number', label: 'Star speed', group: 'Background', min: 0, max: 0.5, step: 0.005 },
  { path: 'global.background.starTwinkle', type: 'number', label: 'Twinkle', group: 'Background', min: 0, max: 1, step: 0.01 },
  { path: 'global.background.haze', type: 'number', label: 'Haze', group: 'Background', min: 0, max: 0.5, step: 0.005 },

  { path: 'global.camera.fov', type: 'number', label: 'FOV', group: 'Camera', min: 30, max: 85, step: 1 },
  { path: 'global.camera.minDistance', type: 'number', label: 'Min distance', group: 'Camera', min: 0.5, max: 10, step: 0.1 },
  { path: 'global.camera.maxDistance', type: 'number', label: 'Max distance', group: 'Camera', min: 5, max: 80, step: 0.5 },
  { path: 'global.camera.autoRotate', type: 'boolean', label: 'Auto rotate', group: 'Camera' },
  { path: 'global.camera.autoRotateSpeed', type: 'number', label: 'Auto rotate speed', group: 'Camera', min: 0, max: 4, step: 0.05 },

  { path: 'global.lighting.keyIntensity', type: 'number', label: 'Key', group: 'Lighting', min: 0, max: 5, step: 0.05 },
  { path: 'global.lighting.fillIntensity', type: 'number', label: 'Fill', group: 'Lighting', min: 0, max: 5, step: 0.05 },
  { path: 'global.lighting.rimIntensity', type: 'number', label: 'Rim', group: 'Lighting', min: 0, max: 8, step: 0.05 },

  // Post
  { path: 'post.enabled', type: 'boolean', label: 'Enabled', group: 'Post' },
  { path: 'post.bloomStrength', type: 'number', label: 'Bloom strength', group: 'Post', min: 0, max: 3, step: 0.01 },
  { path: 'post.bloomThreshold', type: 'number', label: 'Bloom threshold', group: 'Post', min: 0, max: 1, step: 0.005 },
  { path: 'post.bloomRadius', type: 'number', label: 'Bloom radius', group: 'Post', min: 0, max: 1, step: 0.01 },
  { path: 'post.scanlines', type: 'number', label: 'Scanlines', group: 'Post', min: 0, max: 1, step: 0.01 },
  { path: 'post.chroma', type: 'number', label: 'Chromatic', group: 'Post', min: 0, max: 0.01, step: 0.0001 },
  { path: 'post.noise', type: 'number', label: 'Noise', group: 'Post', min: 0, max: 0.5, step: 0.005 },
  { path: 'post.vignette', type: 'number', label: 'Vignette', group: 'Post', min: 0, max: 1, step: 0.01 },

  // Audio
  { path: 'audio.fftSize', type: 'select', label: 'FFT size', group: 'Audio', options: [512, 1024, 2048, 4096, 8192] },
  { path: 'audio.smoothingTimeConstant', type: 'number', label: 'Smoothing', group: 'Audio', min: 0, max: 0.99, step: 0.01 },
  { path: 'audio.gain', type: 'number', label: 'Gain', group: 'Audio', min: 0, max: 3, step: 0.01 },

  // Neon rings
  { path: 'neonRings.ringCount', type: 'number', label: 'Ring count', group: 'Neon Rings', min: 4, max: 40, step: 1 },
  { path: 'neonRings.radius', type: 'number', label: 'Radius', group: 'Neon Rings', min: 0.5, max: 6, step: 0.05 },
  { path: 'neonRings.spacing', type: 'number', label: 'Spacing', group: 'Neon Rings', min: 0.05, max: 1, step: 0.01 },
  { path: 'neonRings.thickness', type: 'number', label: 'Thickness', group: 'Neon Rings', min: 0.01, max: 0.4, step: 0.005 },
  { path: 'neonRings.wobble', type: 'number', label: 'Wobble', group: 'Neon Rings', min: 0, max: 2, step: 0.01 },
  { path: 'neonRings.rotationSpeed', type: 'number', label: 'Rotation speed', group: 'Neon Rings', min: 0, max: 2, step: 0.01 },
  { path: 'neonRings.emissive', type: 'number', label: 'Emissive', group: 'Neon Rings', min: 0, max: 10, step: 0.05 },
  { path: 'neonRings.colorA', type: 'color', label: 'Color A', group: 'Neon Rings' },
  { path: 'neonRings.colorB', type: 'color', label: 'Color B', group: 'Neon Rings' },
  { path: 'neonRings.spectrum', type: 'select', label: 'Spectrum', group: 'Neon Rings', options: ['log', 'linear'] },

  // Chrome grid
  { path: 'chromeGrid.size', type: 'number', label: 'Size', group: 'Chrome Grid', min: 6, max: 40, step: 0.5 },
  { path: 'chromeGrid.segments', type: 'number', label: 'Segments', group: 'Chrome Grid', min: 20, max: 260, step: 1 },
  { path: 'chromeGrid.height', type: 'number', label: 'Height', group: 'Chrome Grid', min: 0, max: 6, step: 0.05 },
  { path: 'chromeGrid.speed', type: 'number', label: 'Speed', group: 'Chrome Grid', min: 0, max: 3, step: 0.01 },
  { path: 'chromeGrid.wireframe', type: 'boolean', label: 'Wireframe', group: 'Chrome Grid' },
  { path: 'chromeGrid.lineOpacity', type: 'number', label: 'Line opacity', group: 'Chrome Grid', min: 0.05, max: 1, step: 0.01 },
  { path: 'chromeGrid.chromeMetalness', type: 'number', label: 'Metalness', group: 'Chrome Grid', min: 0, max: 1, step: 0.01 },
  { path: 'chromeGrid.chromeRoughness', type: 'number', label: 'Roughness', group: 'Chrome Grid', min: 0, max: 1, step: 0.01 },
  { path: 'chromeGrid.accentColor', type: 'color', label: 'Accent', group: 'Chrome Grid' },
  { path: 'chromeGrid.glowColor', type: 'color', label: 'Glow', group: 'Chrome Grid' },

  // Particles
  { path: 'particles.count', type: 'number', label: 'Count', group: 'Particles', min: 1000, max: 60000, step: 100 },
  { path: 'particles.spread', type: 'number', label: 'Spread', group: 'Particles', min: 1, max: 30, step: 0.1 },
  { path: 'particles.size', type: 'number', label: 'Size', group: 'Particles', min: 0.1, max: 5, step: 0.05 },
  { path: 'particles.speed', type: 'number', label: 'Speed', group: 'Particles', min: 0, max: 3, step: 0.01 },
  { path: 'particles.curl', type: 'number', label: 'Curl', group: 'Particles', min: 0, max: 2, step: 0.01 },
  { path: 'particles.opacity', type: 'number', label: 'Opacity', group: 'Particles', min: 0, max: 1, step: 0.01 },
  { path: 'particles.colorA', type: 'color', label: 'Color A', group: 'Particles' },
  { path: 'particles.colorB', type: 'color', label: 'Color B', group: 'Particles' }
];
