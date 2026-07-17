'use client';

/** Route-level error boundary: state what broke and offer a reset, in the terminal's voice. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <div className="text-headline-md font-bold tracking-tighter text-primary">ZYGOS_TERMINAL</div>
      <h1 className="text-title-md text-on-surface">The terminal hit an unexpected error</h1>
      <p className="max-w-md break-words font-mono text-label-sm text-outline">
        {error.message}
        {error.digest ? ` · digest ${error.digest}` : ''}
      </p>
      <p className="max-w-md text-body-sm text-outline">No funds are at risk — Zygos holds nothing. Reload to reconnect to the feed.</p>
      <button onClick={reset} className="rounded bg-primary px-4 py-2 font-mono text-data-mono text-on-primary transition-colors hover:bg-primary-container">
        Reload terminal
      </button>
    </div>
  );
}
