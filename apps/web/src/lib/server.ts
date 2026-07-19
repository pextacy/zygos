/**
 * Server endpoints. Only NEXT_PUBLIC_SERVER_WS_URL and NEXT_PUBLIC_CLUSTER
 * reach the browser (CLAUDE.md §9); the HTTP base derives from the WS URL.
 */

export const WS_URL = process.env.NEXT_PUBLIC_SERVER_WS_URL ?? 'ws://localhost:8080/ws';

export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? 'devnet') as 'mainnet-beta' | 'devnet';

export function httpBase(): string {
  const u = new URL(WS_URL);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  return u.toString().replace(/\/$/, '');
}

/** Solana Explorer link for an on-chain signature, on the configured cluster. */
export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${CLUSTER === 'devnet' ? '?cluster=devnet' : ''}`;
}

/** Marks a network-level failure (server not reachable yet: cold start, offline, DNS) vs a real HTTP error response. */
export class TransportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransportError';
  }
}

/** True when the failure is "server not reachable yet" (transient) rather than a real server-side error. */
export function isTransient(err: unknown): boolean {
  return err instanceof TransportError;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${httpBase()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    // fetch() rejects only on transport failure (server down / cold start /
    // offline), never on an HTTP error status — classify it so callers can
    // treat it as a benign "connecting…" instead of a hard error.
    throw new TransportError(cause);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}
