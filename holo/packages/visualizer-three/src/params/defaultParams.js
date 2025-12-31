export const defaultParams = {
  preset: "neonRings",

  // Global look & feel
  global: {
    background: {
      colorTop: "#050015",
      colorBottom: "#070a26",
      starDensity: 0.75, // 0..1
      starSpeed: 0.06, // 0..1-ish
      starTwinkle: 0.35, // 0..1
      haze: 0.08, // 0..1 (fog-ish)
    },
    camera: {
      fov: 55,
      minDistance: 3.0,
      maxDistance: 28.0,
      autoRotate: false,
      autoRotateSpeed: 0.6,
    },
    controls: {
      enablePan: true,
      enableZoom: true,
      dampingFactor: 2,
    },
    lighting: {
      keyIntensity: 1.2,
      fillIntensity: 0.6,
      rimIntensity: 1.4,
    },
  },

  // Post-processing
  post: {
    enabled: true,
    bloomStrength: 0.35,
    bloomThreshold: 0.2,
    bloomRadius: 0.16,
    scanlines: 0.22,
    chroma: 0.0018,
    noise: 0.05,
    vignette: 0.28,
  },

  // Audio analysis knobs
  audio: {
    fftSize: 2048,
    smoothingTimeConstant: 0.82,
    gain: 1.0,
  },

  // Preset-specific params
  neonRings: {
    ringCount: 18,
    radius: 2.3,
    spacing: 0.25,
    thickness: 0.06,
    wobble: 0.35,
    rotationSpeed: 0.25,
    emissive: 2.2,
    colorA: "#00e5ff",
    colorB: "#ff4fd8",
    spectrum: "log", // 'linear' | 'log'
  },

  chromeGrid: {
    size: 18,
    segments: 140,
    height: 1.35,
    speed: 0.75,
    wireframe: true,
    lineOpacity: 0.7,
    chromeMetalness: 1.0,
    chromeRoughness: 0.12,
    accentColor: "#79fff7",
    glowColor: "#ff66dd",
  },

  particles: {
    count: 12000,
    spread: 9.5,
    size: 2.0,
    speed: 0.35,
    curl: 0.65,
    colorA: "#a6fffb",
    colorB: "#ff9cf2",
    opacity: 0.85,
  },
};
