/**
 * Augments Express's `Request` with the fields auth middleware attaches.
 * `apps/api/src/middleware/auth.ts` is the only place that sets `tenantId` —
 * every route handler downstream can read it as a plain, already-verified
 * string instead of re-deriving it from a header or query param.
 */
import 'express';

declare module 'express' {
  interface Request {
    /**
     * Optional at the type level (Express's own `Request` type has no idea
     * `requireApiKey` ran before a given handler) but guaranteed present in
     * practice: every route that reads it is mounted behind `requireApiKey`,
     * which always sets it or short-circuits with a 401 first. `tenantOf()`
     * in `routes/tenant.ts` is the one place that asserts this.
     */
    tenantId?: string;
  }
}
