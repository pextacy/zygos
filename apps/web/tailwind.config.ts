import type { Config } from 'tailwindcss';

/**
 * "Modern Professional Fintech" design system (docs: stitch export DESIGN.md).
 * Light slate surfaces, deep-indigo primary, Geist + JetBrains Mono.
 * Token names and values mirror the Stitch code.html export 1:1.
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
        'surface-variant': '#e0e3e5',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f2f4f6',
        'surface-container': '#eceef0',
        'surface-container-high': '#e6e8ea',
        'surface-container-highest': '#e0e3e5',
        'on-surface': '#191c1e',
        'on-surface-variant': '#464554',
        outline: '#777586',
        'outline-variant': '#c7c4d7',
        primary: '#2a14b4',
        'on-primary': '#ffffff',
        'primary-container': '#4338ca',
        'on-primary-container': '#c1beff',
        'primary-fixed': '#e3dfff',
        'primary-fixed-dim': '#c3c0ff',
        secondary: '#565e74',
        'on-secondary': '#ffffff',
        'secondary-container': '#dae2fd',
        'on-secondary-container': '#5c647a',
        tertiary: '#2b3b50',
        'tertiary-container': '#425268',
        error: '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',
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
        float: '0px 4px 12px rgba(15, 23, 42, 0.08)',
        card: '0px 4px 12px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
};

export default config;
