/**
 * db — Prisma ORM client and repository helpers.
 *
 * Exports:
 *   - prisma  (singleton PrismaClient)
 *   - Repository functions: createRun, tryTransitionNodeRun, etc.
 *
 * Rule: no raw Prisma calls in apps/api or apps/worker routes/handlers.
 *       All DB access goes through the helpers exported here.
 *
 * Full schema and repositories defined in Phase 3.
 */

// Phase 3 exports — stub for Phase 0 typecheck pass
export {};
