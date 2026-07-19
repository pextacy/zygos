'use client';

import { useEffect, useState } from 'react';
import { api } from './server';
import type { HealthDto } from './types';

export type HealthPhase = 'loading' | 'ok' | 'unreachable';

export interface HealthStatus {
  /** Last successful /healthz payload; kept across a transient poll failure so the UI doesn't flap. */
  health: HealthDto | null;
  /** loading = never fetched yet; ok = last poll succeeded; unreachable = repeated failures. */
  phase: HealthPhase;
}

/**
 * Poll GET /healthz. A single transient failure (cold start, one dropped poll)
 * must NOT wipe the last-good diagnostics to a red "unreachable" — that's the
 * same false-alarm class as the feed bug. Keep the last value, and only report
 * `unreachable` after two consecutive failures.
 */
export function useHealth(intervalMs = 15_000): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>({ health: null, phase: 'loading' });

  useEffect(() => {
    let alive = true;
    let fails = 0;
    const tick = () => {
      api<HealthDto>('/healthz')
        .then((h) => {
          if (!alive) return;
          fails = 0;
          setStatus({ health: h, phase: 'ok' });
        })
        .catch(() => {
          if (!alive) return;
          fails += 1;
          // Keep the last-good health; only escalate to unreachable after a
          // second consecutive failure (one blip is almost always transient).
          setStatus((prev) => ({ health: prev.health, phase: fails >= 2 ? 'unreachable' : prev.phase === 'loading' ? 'loading' : 'ok' }));
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return status;
}
