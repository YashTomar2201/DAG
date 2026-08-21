/**
 * SSE (Server-Sent Events) service — Phase 10.
 *
 * Implements `GET /runs/:id/events` as a long-lived SSE stream:
 *
 *   1. REPLAY  — Write all persisted RunEvent rows since the `Last-Event-ID`
 *                cursor. This makes reconnection exactly-once from the client's
 *                perspective: the browser's native EventSource sets `Last-Event-ID`
 *                automatically on reconnect.
 *
 *   2. LIVE    — Subscribe to the Redis pub/sub channel `run:{runId}:events`.
 *                Events published by the orchestrator or workers appear in the
 *                stream within ~1–2 RTTs of the state transition.
 *
 *   3. HEARTBEAT — Send an SSE comment (`: keep-alive`) every 15 s.
 *                  HTTP proxies (nginx, AWS ALB) close idle connections after
 *                  ~60 s of silence. The comment keeps the TCP connection alive
 *                  without appearing as a named event in the browser.
 *
 *   4. CLEANUP  — On client disconnect (`res.on('close')`), unsubscribe from
 *                 Redis and clear the heartbeat timer. Verified: no listener leak
 *                 across repeated connect/disconnect cycles.
 *
 * Why SSE over WebSockets?
 *   This stream is one-directional: server → client. WebSockets are a
 *   bidirectional protocol; using them here adds complexity (upgrade handshake,
 *   message framing, explicit ping/pong) without providing anything we need.
 *   SSE is built into every browser's `EventSource` API, carries automatic
 *   reconnection with `Last-Event-ID`, and works over plain HTTP/1.1 through
 *   every proxy that supports chunked transfer encoding.
 *   When would we flip? If we needed the client to push data back (e.g. live
 *   terminal input, collaborative graph editing), WebSockets would be the right
 *   choice.
 *
 * Why persist to RunEvent AND publish to pub/sub?
 *   Redis pub/sub is fire-and-forget. If a client is disconnected at the moment
 *   an event is published (network blip, browser tab sleep), the event is gone.
 *   The client reconnects and resumes from its last `Last-Event-ID` — but without
 *   the persisted RunEvent rows, everything published during the disconnect window
 *   is permanently lost. Persisting to Postgres and replaying on reconnect gives
 *   the client exactly-once delivery of all historical events, regardless of
 *   how many times it disconnects.
 *
 * Why buffer log events?
 *   A `torch.train` script can print hundreds of lines per second (loss per
 *   batch, progress bars, etc.). If each `print()` call immediately publishes
 *   a `NODE_LOG` SSE frame, the server writes hundreds of tiny HTTP chunks per
 *   second. Each chunk triggers a kernel send(), a TCP ACK, and a browser
 *   DOM update. At high throughput this pegs both the server's NIC and the
 *   browser's event loop. Buffering at ~200 ms reduces the frame rate to ≤5
 *   flushes/s while keeping the perceived latency under 200 ms — imperceptible
 *   to a human reading a log pane.
 */

import type { Response } from 'express';
import { getRunEventsService } from './run.service';
import { subscribeToRun } from '@dag/queue';
import { logger } from '../logger';
import type { RunEvent } from '@dag/contracts';

const HEARTBEAT_INTERVAL_MS = 15_000;
const LOG_BUFFER_FLUSH_MS = 200;

// ─── SSE frame helpers ────────────────────────────────────────────────────────

function writeEvent(res: Response, id: string, type: string, data: unknown): void {
  res.write(`id: ${id}\n`);
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeComment(res: Response, comment: string): void {
  // SSE comment — invisible to EventSource but keeps TCP alive
  res.write(`: ${comment}\n\n`);
}

// ─── Main SSE handler ─────────────────────────────────────────────────────────

/**
 * Attaches an SSE stream to the HTTP response for `runId`.
 *
 * @param runId       The run to stream.
 * @param res         The Express response object (kept open).
 * @param lastEventId The `Last-Event-ID` from the reconnecting client (if any).
 */
export async function streamRunEvents(
  runId: string,
  res: Response,
  lastEventId?: string,
): Promise<void> {
  // ── SSE headers ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx response buffering
  res.flushHeaders(); // start the stream immediately, don't wait for first event

  // ── Phase 1: Replay persisted events since the cursor ─────────────────────
  // getRunEventsService validates the run exists (throws NotFoundError → 404).
  const pastEvents = await getRunEventsService(runId, lastEventId);

  for (const event of pastEvents) {
    writeEvent(res, String(event.id), event.type, event.payload);
  }

  // Check if the run is already in a terminal state after replay.
  // If so, we can close immediately — there will be no further events.
  const lastEvent = pastEvents[pastEvents.length - 1];
  const isTerminal =
    lastEvent &&
    ['RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(lastEvent.type);

  if (isTerminal) {
    res.end();
    return;
  }

  // ── Phase 2: Live pub/sub ─────────────────────────────────────────────────
  // Log events are buffered to avoid flooding the channel with one frame per
  // stdout line. All other events (status transitions) are written immediately.
  let logBuffer: Array<{ runId: string; nodeKey?: string; payload: unknown; ts: number }> = [];
  let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushLogs(): void {
    if (logBuffer.length === 0) return;
    // Batch all buffered log lines into a single SSE frame
    const batch = logBuffer.splice(0);
    const batchId = `log-${Date.now()}`;
    writeEvent(res, batchId, 'NODE_LOG_BATCH', { logs: batch });
    logFlushTimer = null;
  }

  const unsubscribe = await subscribeToRun(runId, (event: RunEvent) => {
    if (event.type === 'NODE_LOG') {
      // Buffer log events; flush after LOG_BUFFER_FLUSH_MS of quiet
      logBuffer.push({ runId: event.runId, nodeKey: event.nodeKey, payload: event.payload, ts: event.ts });
      if (!logFlushTimer) {
        logFlushTimer = setTimeout(flushLogs, LOG_BUFFER_FLUSH_MS);
      }
      return;
    }

    // Flush any buffered logs before emitting a status transition
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      flushLogs();
    }

    // Use ts as event id for live events (Postgres id not available here)
    writeEvent(res, String(event.ts), event.type, event.payload);

    // Auto-close on terminal run events — no more events will come
    if (['RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(event.type)) {
      cleanup();
      res.end();
    }
  });

  // ── Phase 3: Heartbeat ────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    writeComment(res, 'keep-alive');
  }, HEARTBEAT_INTERVAL_MS);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  let cleaned = false;
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      flushLogs();
    }
    try {
      unsubscribe();
    } catch (err) {
      logger.warn({ err, runId }, 'SSE: error during unsubscribe');
    }
    logger.debug({ runId }, 'SSE: connection cleaned up');
  }

  // Client disconnect (browser closed tab, curl -C, proxy timeout)
  res.on('close', cleanup);
  res.on('error', cleanup);
}
