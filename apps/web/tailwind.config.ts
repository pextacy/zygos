import type { Config } from 'tailwindcss';

/**
 * "Modern Professional Fintech" design system — mirrors the Stitch export
 * (docs: stitch_zygos_terminal/.../DESIGN.md) 1:1. Light slate surfaces,
 * deep-indigo primary, Geist + JetBrains Mono, tonal depth via 1px slate
 * borders (no resting shadows). Token names are consumed across every
 * component, so the whole app is themed from these values.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#f7f9fb',
        'on-background': '#191c1e',
        surface: '#f7f9fb',
        'surface-dim': '#d8dadc',
        'surface-bright': '#f7f9fb',
        'surface-variant': '#e0e3e5',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f2f4f6',
        'surface-container': '#eceef0',
        'surface-container-high': '#e6e8ea',
        'surface-container-highest': '#e0e3e5',
        'on-surface': '#191c1e',
        'on-surface-variant': '#464554',
        'inverse-surface': '#2d3133',
        'inverse-on-surface': '#eff1f3',
        outline: '#777586',
        'outline-variant': '#c7c4d7',
        'surface-tint': '#5148d7',
        primary: '#2a14b4',
        'on-primary': '#ffffff',
        'primary-container': '#4338ca',
        'on-primary-container': '#c1beff',
        'inverse-primary': '#c3c0ff',
        'primary-fixed': '#e3dfff',
        'primary-fixed-dim': '#c3c0ff',
        'on-primary-fixed': '#100069',
        'on-primary-fixed-variant': '#372abf',
        secondary: '#565e74',
        'on-secondary': '#ffffff',
        'secondary-container': '#dae2fd',
        'on-secondary-container': '#5c647a',
        'secondary-fixed': '#dae2fd',
        'secondary-fixed-dim': '#bec6e0',
        'on-secondary-fixed': '#131b2e',
        'on-secondary-fixed-variant': '#3f465c',
        tertiary: '#2b3b50',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#425268',
        'on-tertiary-container': '#b5c5df',
        error: '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',
        // positive/negative market movement (DESIGN.md: green growth, red loss)
        positive: '#0f9d58',
        'positive-container': '#e2f5ec',
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.5rem',
        full: '9999px',
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
        // Depth only on floating elements (dropdowns, modals) per DESIGN.md.
        float: '0px 4px 12px rgba(15, 23, 42, 0.08)',
        card: '0px 1px 2px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
};

export default config;
