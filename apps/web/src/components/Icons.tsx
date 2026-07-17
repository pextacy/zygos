/** Minimal inline icon set (Material-Symbols-outlined flavor, self-hosted as SVG). */

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-5 w-5'} aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconTerminal({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12.5 15H17" />
    </Svg>
  );
}

export function IconPortfolio({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 3a9 9 0 1 0 9 9h-9V3z" />
      <path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5z" />
    </Svg>
  );
}

export function IconAutomation({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </Svg>
  );
}

export function IconAnalytics({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
    </Svg>
  );
}

export function IconPlus({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconClose({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconRefresh({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </Svg>
  );
}
