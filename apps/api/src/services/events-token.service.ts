/**
 * Roadmap A3 — the browser's `EventSource` cannot send custom headers, so
 * `GET /runs/:id/events` can't require `Authorization: Bearer <key>` the way
 * every other route does. Instead, an already-authenticated request mints a
 * short-lived, single-run-scoped token via `POST /runs/:id/events-token`; the
 * frontend appends it as `?eventsToken=` when opening the stream.
 *
 * This is an HMAC, not a lookup table — nothing to store or clean up, and
 * verification is one hash comparison. The token only ever grants read
 * access to one run's event log, never a mutating action, so a 30-minute
 * window is a reasonable trade against "a very long run's SSE connection
 * drops and has to be re-opened with a fresh token."
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../env';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function sign(payload: string): string {
  return createHmac('sha256', env.EVENTS_TOKEN_SECRET).update(payload).digest('hex');
}

/** Mints a token scoped to exactly this `(tenantId, runId)` pair. */
export function mintEventsToken(tenantId: string, runId: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${tenantId}.${runId}.${expiresAt}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/**
 * Verifies a token against the run it's being presented for. Returns the
 * tenantId it was minted for, or `null` if the token is malformed, expired,
 * signed for a different run, or forged.
 */
export function verifyEventsToken(token: string, runId: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts as [string, string];

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = sign(payload);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const segments = payload.split('.');
  if (segments.length !== 3) return null;
  const [tenantId, tokenRunId, expiresAtRaw] = segments as [string, string, string];
  if (tokenRunId !== runId) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  return tenantId;
}
