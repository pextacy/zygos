import type { Config } from 'tailwindcss';

/**
 * "Ink Terminal" design system. A live probability-trading terminal, not a
 * light SaaS dashboard. Two temperatures carry meaning: cyan = live market
 * truth flowing in (feed, consensus, brand); amber-gold = value/edge you
 * capture (lock-in, money); rose = risk / stale / offline. Deep desaturated
 * blue-ink surfaces (never pure black), warm-cool off-white text, crisp radii,
 * mono-forward chrome. Token NAMES are unchanged so every component re-skins
 * from these values alone.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ink surface stack — each step a hair lighter to signal elevation on dark
        background: '#0a0e13',
        'on-background': '#e6edf3',
        surface: '#0a0e13',
        'surface-dim': '#06090d',
        'surface-variant': '#1a222b',
        'surface-container-lowest': '#0d1219',
        'surface-container-low': '#10161e',
        'surface-container': '#141c25',
        'surface-container-high': '#1a232d',
        'surface-container-highest': '#212c37',
        'on-surface': '#e6edf3',
        'on-surface-variant': '#93a1af',
        outline: '#55636f',
        'outline-variant': '#222c37',
        // primary = cyan: live signal, consensus, brand
        primary: '#22d3ee',
        'on-primary': '#042028',
        'primary-container': '#0a3a45',
        'on-primary-container': '#a9eef7',
        'primary-fixed': '#0e2830',
        'primary-fixed-dim': '#17505c',
        // secondary = amber-gold: edge, captured value, actionable warmth
        secondary: '#f5b53f',
        'on-secondary': '#241a00',
        'secondary-container': '#3a2b00',
        'on-secondary-container': '#ffdf9e',
        tertiary: '#0a0e13',
        'tertiary-container': '#2b3b50',
        // error = rose: risk, stale, offline (never fire-engine red)
        error: '#ff7a86',
        'on-error': '#2a0709',
        'error-container': '#3a1316',
        'on-error-container': '#ffc9cd',
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
      fontFamily: {
        sans: ['var(--font-geist)', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-md': ['28px', { lineHeight: '36px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-sm': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'title-md': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'body-lg': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'body-md': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'data-mono': ['14px', { lineHeight: '20px', fontWeight: '500' }],
        'label-sm': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '500' }],
        'label-caps': ['12px', { lineHeight: '16px', letterSpacing: '0.1em', fontWeight: '600' }],
      },
      boxShadow: {
        // On ink, elevation reads through a faint top-highlight + deep drop,
        // not a soft gray blur (which would vanish against dark surfaces).
        float: 'inset 0 1px 0 0 rgba(255,255,255,0.04), 0 10px 30px -8px rgba(0,0,0,0.6)',
        card: 'inset 0 1px 0 0 rgba(255,255,255,0.03), 0 6px 18px -10px rgba(0,0,0,0.5)',
        'glow-live': '0 0 16px -2px rgba(34,211,238,0.55)',
        'glow-stale': '0 0 16px -2px rgba(255,122,134,0.5)',
      },
    },
  },
  plugins: [],
};

export default config;
