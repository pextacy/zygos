import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { ConsensusSnapshot, MatchEvent } from '@zygos/core';
import { marketKeyString } from '@zygos/core';
import type { FastifyBaseLogger } from 'fastify';
import type { FeedService } from './feed.js';
import type { RuleEngine } from './rules.js';
import type { ValuationListener, ValuationService } from './valuation.js';

/**
 * WS fanout (DOCS.md §8). Outbound frames: HELLO, CONSENSUS, EVENT,
 * FEED_HEALTH, and VALUATION for wallets subscribed while a venue adapter is
 * configured. No synthetic valuations are ever emitted.
 */

const subscribeFrameSchema = z.object({
  type: z.literal('SUBSCRIBE'),
  wallet: z.string().min(32).max(64).optional(),
  fixtureIds: z.array(z.string().min(1)).max(50),
});

const HEALTH_INTERVAL_MS = 5_000;

export function attachWs(
  server: Server,
  feed: FeedService,
  valuation: ValuationService | null,
  ruleEngine: RuleEngine | null,
  log: FastifyBaseLogger,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const walletBySocket = new Map<WebSocket, string>();

  const broadcast = (frame: object): void => {
    const payload = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  // RULE_FIRED goes only to sockets subscribed with the owning wallet (full-screen signable prompt, FR-42).
  const toOwner = (frame: { wallet: string }) => {
    const payload = JSON.stringify(frame);
    for (const [client, wallet] of walletBySocket) {
      if (wallet === frame.wallet && client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };
  ruleEngine?.onFired(toOwner);
  // Phase 4: delegated executions notify the owner — no signature needed, tx already landed.
  ruleEngine?.onExecuted(toOwner);

  feed.addListener({
    onConsensus: (snap: ConsensusSnapshot) =>
      broadcast({
        type: 'CONSENSUS',
        fixtureId: snap.fixtureId,
        market: marketKeyString(snap.market),
        probs: snap.probs,
        bookCount: snap.bookCount,
        confidence: snap.confidence,
        packetIds: snap.packetIds,
        asOf: snap.asOf,
      }),
    onEvent: (event: MatchEvent) => broadcast({ type: 'EVENT', event }),
  });

  const healthTimer = setInterval(() => {
    const states = feed.feedStates();
    for (const [fixtureId, state] of Object.entries(states)) {
      broadcast({ type: 'FEED_HEALTH', fixtureId, state });
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'HELLO', serverTime: Date.now() }));
    const valuationListeners: ValuationListener[] = [];

    socket.on('close', () => {
      for (const l of valuationListeners) valuation?.removeListener(l);
      valuationListeners.length = 0;
      walletBySocket.delete(socket);
    });

    socket.on('message', (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        socket.send(JSON.stringify({ type: 'ERROR', code: 'BAD_JSON' }));
        return;
      }
      const frame = subscribeFrameSchema.safeParse(json);
      if (!frame.success) {
        socket.send(JSON.stringify({ type: 'ERROR', code: 'BAD_FRAME', detail: frame.error.issues[0]?.message }));
        return;
      }
      feed
        .subscribe(frame.data.fixtureIds)
        .then(() => {
          if (frame.data.wallet !== undefined) {
            walletBySocket.set(socket, frame.data.wallet);
            if (valuation === null) {
              socket.send(JSON.stringify({ type: 'ERROR', code: 'NO_VENUE_ADAPTER', detail: 'no venue configured — positions cannot be valued' }));
            } else {
              const listener: ValuationListener = {
                wallet: frame.data.wallet,
                onValuation: (v) => {
                  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'VALUATION', ...v }));
                },
              };
              valuationListeners.push(listener);
              valuation.addListener(listener);
            }
          }
          socket.send(JSON.stringify({ type: 'SUBSCRIBED', fixtureIds: frame.data.fixtureIds }));
        })
        .catch((err: unknown) => {
          log.error({ err }, 'ws subscribe failed');
          socket.send(JSON.stringify({ type: 'ERROR', code: 'SUBSCRIBE_FAILED' }));
        });
    });
  });

  wss.on('close', () => clearInterval(healthTimer));
  return wss;
}
