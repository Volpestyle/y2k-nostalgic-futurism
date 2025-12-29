export const presets = [
  {
    id: 'neonRings',
    label: 'Neon Rings (Y2K Halo)',
    visualizer: 'neonRings',
    params: {
      preset: 'neonRings',
      post: { bloomStrength: 0.35, bloomThreshold: 0.2, bloomRadius: 0.16, scanlines: 0.24, chroma: 0.0018, vignette: 0.28 },
      global: {
        background: { colorTop: '#050015', colorBottom: '#070a26', starDensity: 0.78, starTwinkle: 0.38, haze: 0.085 }
      },
      neonRings: {
        ringCount: 18,
        radius: 2.3,
        spacing: 0.25,
        thickness: 0.06,
        wobble: 0.35,
        rotationSpeed: 0.25,
        emissive: 2.2,
        colorA: '#00e5ff',
        colorB: '#ff4fd8',
        spectrum: 'log'
      }
    }
  },
  {
    id: 'chromeGrid',
    label: 'Chrome Grid (Retro Wavefield)',
    visualizer: 'chromeGrid',
    params: {
      preset: 'chromeGrid',
      post: { bloomStrength: 0.3, bloomThreshold: 0.22, bloomRadius: 0.14, scanlines: 0.18, chroma: 0.0016, vignette: 0.22 },
      global: {
        background: { colorTop: '#00030d', colorBottom: '#0b1638', starDensity: 0.62, starTwinkle: 0.26, haze: 0.11 }
      },
      chromeGrid: {
        size: 20,
        segments: 160,
        height: 1.7,
        speed: 0.85,
        wireframe: true,
        lineOpacity: 0.74,
        chromeMetalness: 1.0,
        chromeRoughness: 0.09,
        accentColor: '#79fff7',
        glowColor: '#ff66dd'
      }
    }
  },
  {
    id: 'particles',
    label: 'Particle Orbital (Starburst Core)',
    visualizer: 'particles',
    params: {
      preset: 'particles',
      post: { bloomStrength: 0.45, bloomThreshold: 0.18, bloomRadius: 0.22, scanlines: 0.26, chroma: 0.0021, vignette: 0.30 },
      global: {
        background: { colorTop: '#02000a', colorBottom: '#090920', starDensity: 0.92, starTwinkle: 0.44, haze: 0.06 }
      },
      particles: {
        count: 16000,
        spread: 10.5,
        size: 2.4,
        speed: 0.38,
        curl: 0.78,
        opacity: 0.9,
        colorA: '#a6fffb',
        colorB: '#ff9cf2'
      }
    }
  }
];
