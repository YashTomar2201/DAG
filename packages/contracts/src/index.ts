/**
 * contracts — shared Zod schemas and inferred TypeScript types.
 *
 * This is the single source of truth for every wire format in the system:
 *   - NodeDef, EdgeDef, GraphSchema  (what the user draws)
 *   - NodeStatus, RunStatus enums    (the state machines)
 *   - Job payload                    (what goes on the Redis queue)
 *   - Run event envelope             (what SSE streams to the browser)
 *
 * Rule: types are always inferred via z.infer<typeof Schema>.
 * Never hand-write a TypeScript interface that duplicates a Zod schema.
 *
 * Full schemas defined in Phase 1.
 */

// Phase 1 exports — stub for Phase 0 typecheck pass
export {};
