import type { Request } from 'express';

/**
 * Roadmap A3: `req.tenantId` is set by `requireApiKey` (see
 * `middleware/auth.ts`) from a verified API key before any route handler
 * runs — this is no longer a shim reading a caller-supplied `?tenantId=`
 * query param. Kept as a named accessor (rather than every route reading
 * `req.tenantId` directly) so route files didn't all need editing when A3
 * landed, and so a future change to how identity is threaded through only
 * touches this one function.
 */
export function tenantOf(req: Request): string {
  if (!req.tenantId) {
    // Would mean a route reads this without being mounted behind
    // `requireApiKey` first — a wiring bug in app.ts/route setup, not
    // something a caller can trigger.
    throw new Error('tenantOf() called on a request with no authenticated tenant — is requireApiKey missing on this route?');
  }
  return req.tenantId;
}
