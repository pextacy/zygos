'use client';

import { useEffect, useState } from 'react';
import { api } from './server';
import type { HealthDto } from './types';

/** Poll GET /healthz so the UI reflects the server's own diagnostics (feed link, RPC, TxLINE config). */
export function useHealth(intervalMs = 15_000): HealthDto | null {
  const [health, setHealth] = useState<HealthDto | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api<HealthDto>('/healthz')
        .then((h) => {
          if (alive) setHealth(h);
        })
        .catch(() => {
          if (alive) setHealth(null);
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return health;
}
