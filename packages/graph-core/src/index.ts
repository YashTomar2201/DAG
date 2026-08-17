/**
 * graph-core — pure, dependency-free graph algorithms.
 *
 * ZERO runtime dependencies by design. This package is imported by:
 *   - apps/api  (Node.js — runs topological sort before persisting a version)
 *   - apps/web  (browser — runs cycle detection on every edge connect for instant UI feedback)
 *
 * The zero-dependency rule ensures the browser bundle stays lean and that
 * the exact same validation logic runs on both sides — no divergence.
 *
 * Exports added in Phase 2:
 *   - buildAdjacency
 *   - detectCycle
 *   - topologicalSort
 *   - validateGraph
 */

// Phase 2 exports — stub for Phase 0 typecheck pass
export {};
