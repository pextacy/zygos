import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { ConsensusSnapshot, MatchEvent } from '@zygos/core';
import { marketKeyString } from '@zygos/core';
import type { FastifyBaseLogger } from 'fastify';
import type { FeedService } from './feed.js';

/**
 * WS fanout (DOCS.md §8). Outbound frames: HELLO, CONSENSUS, EVENT,
 * FEED_HEALTH. VALUATION frames join once a venue adapter is selected and
 * wired (PLAN.md T1.4/T1.5 — venue liquidity gate pending); no synthetic
 * valuations are ever emitted.
 */

const subscribeFrameSchema = z.object({
  type: z.literal('SUBSCRIBE'),
  wallet: z.string().min(32).max(64).optional(),
  fixtureIds: z.array(z.string().min(1)).max(50),
});

const HEALTH_INTERVAL_MS = 5_000;

export function attachWs(server: Server, feed: FeedService, log: FastifyBaseLogger): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (frame: object): void => {
    const payload = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

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
        .then(() => socket.send(JSON.stringify({ type: 'SUBSCRIBED', fixtureIds: frame.data.fixtureIds })))
        .catch((err: unknown) => {
          log.error({ err }, 'ws subscribe failed');
          socket.send(JSON.stringify({ type: 'ERROR', code: 'SUBSCRIBE_FAILED' }));
        });
    });
  });

  wss.on('close', () => clearInterval(healthTimer));
  return wss;
}
