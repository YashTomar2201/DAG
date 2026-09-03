import type { Request } from 'express';

/**
 * Tenant scoping shim. Until A3 (auth) lands, the tenant comes from a
 * `?tenantId=` query param and defaults to "default" — the single-tenant
 * editor's fixed id. A3 replaces this with `req.tenantId` from a verified key.
 */
export function tenantOf(req: Request): string {
  const q = req.query['tenantId'];
  return typeof q === 'string' && q.length > 0 ? q : 'default';
}
