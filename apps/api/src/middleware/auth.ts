/**
 * Roadmap A3 — API-key authentication.
 *
 * Every protected route needs `tenantId` to come from a verified credential,
 * not a request body/query field the caller can type themselves (the
 * `?tenantId=` shim this replaces — see `apps/api/src/routes/tenant.ts`).
 */
import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { findActiveApiKeyByHash } from '@dag/db';
import { UnauthorizedError } from '../errors';

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Reads `Authorization: Bearer <key>`, hashes it, and looks up the tenant it
 * belongs to. Sets `req.tenantId` on success; calls `next(UnauthorizedError)`
 * on a missing header, malformed header, or a key that doesn't match any
 * active (non-revoked) row — the same 401 either way, so a caller can't use
 * the error to distinguish "wrong key" from "revoked key" from "no key".
 */
export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    next(new UnauthorizedError('Missing or malformed Authorization header (expected "Bearer <api-key>")'));
    return;
  }
  const raw = match[1]!.trim();
  if (!raw) {
    next(new UnauthorizedError('Missing or malformed Authorization header (expected "Bearer <api-key>")'));
    return;
  }

  try {
    const key = await findActiveApiKeyByHash(hashApiKey(raw));
    if (!key) {
      next(new UnauthorizedError('Invalid or revoked API key'));
      return;
    }
    req.tenantId = key.tenantId;
    next();
  } catch (err) {
    next(err);
  }
}
