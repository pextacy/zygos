'use client';

import { useCallback, useEffect, useRef } from 'react';
import { WS_URL } from './server';
import type { Action } from './store';
import type { ServerFrame } from './types';

/** WS client with reconnect; dispatches frames into the terminal reducer. */
export function useZygosSocket(dispatch: (a: Action) => void, wallet: string | null, fixtureIds: string[]) {
  const socketRef = useRef<WebSocket | null>(null);
  const subscriptionRef = useRef<{ wallet: string | null; fixtureIds: string[] }>({ wallet, fixtureIds });
  subscriptionRef.current = { wallet, fixtureIds };

  const sendSubscribe = useCallback(() => {
    const socket = socketRef.current;
    const { wallet: w, fixtureIds: ids } = subscriptionRef.current;
    if (socket?.readyState === WebSocket.OPEN && (ids.length > 0 || w)) {
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', ...(w ? { wallet: w } : {}), fixtureIds: ids }));
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let retryMs = 1_000;

    function connect() {
      if (closed) return;
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        retryMs = 1_000;
        dispatch({ type: 'socket', connected: true });
        sendSubscribe();
      };
      socket.onclose = () => {
        dispatch({ type: 'socket', connected: false });
        if (!closed) {
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      };
      socket.onmessage = (msg) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(msg.data)) as ServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case 'HELLO':
            dispatch({ type: 'hello', serverTime: frame.serverTime });
            break;
          case 'CONSENSUS':
            dispatch({ type: 'consensus', frame });
            break;
          case 'EVENT':
            dispatch({ type: 'event', event: frame.event });
            break;
          case 'FEED_HEALTH':
            dispatch({ type: 'feedHealth', fixtureId: frame.fixtureId, state: frame.state });
            break;
          case 'VALUATION':
            dispatch({ type: 'valuation', dto: frame });
            break;
          case 'RULE_FIRED':
            dispatch({ type: 'ruleFired', frame });
            break;
          case 'RULE_EXECUTED':
            dispatch({ type: 'ruleExecuted', frame });
            break;
          case 'SUBSCRIBED':
            dispatch({ type: 'subscribed', fixtureIds: frame.fixtureIds });
            break;
          case 'ERROR':
            dispatch({ type: 'log', kind: 'error', text: `server: ${frame.code}${frame.detail ? ` — ${frame.detail}` : ''}` });
            break;
          default:
            break;
        }
      };
    }

    connect();
    return () => {
      closed = true;
      socketRef.current?.close();
    };
    // Intentionally connect once; subscription changes are handled below.
  }, [dispatch, sendSubscribe]);

  // Re-subscribe whenever wallet or fixture list changes.
  useEffect(() => {
    sendSubscribe();
  }, [wallet, fixtureIds, sendSubscribe]);
}
