import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Dark terminal aesthetic (PRD FR-50, DOCS.md §2) — palette refined in T2.4.
      colors: {
        terminal: {
          bg: '#0a0e12',
          panel: '#11161d',
          border: '#1f2933',
          text: '#d7e0ea',
          dim: '#7b8794',
          accent: '#4cc38a',
          warn: '#f5a623',
          danger: '#e5484d',
        },
      },
    },
  },
  plugins: [],
};

export default config;
