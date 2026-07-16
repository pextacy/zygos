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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}
