# Phase 12 — Scale Test Results

Generated: 2026-08-21T05:11:39.838Z

Graph: 10-node fan-out/fan-in (1 root -> 8 parallel branches -> 1 sink), 200 concurrent runs per pass, CPU_CONCURRENCY=8 per worker (held constant across passes so worker COUNT is the only variable).

| Workers | Runs | Nodes completed | Wall clock | Throughput | p50 | p95 | p99 | Max queue depth | Avg queue depth |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 200 | 2000 | 182.0s | 11.0 nodes/s | 585ms | 908ms | 1069ms | 1604 | 717.7 |
| 4 | 200 | 2000 | 162.1s | 12.3 nodes/s | 2031ms | 4097ms | 5205ms | 1542 | 790.0 |

- 4 workers vs 1: **1.12x** throughput

## How to read this table

- **Throughput** (nodes/s) is the primary horizontal-scaling signal: it should scale roughly with worker count, since `queue:cpu`'s waiting jobs are the shared resource every worker process pulls from independently.
- **p95 node latency** captures tail behaviour, not just the average — a system that's fast on average but has a long tail under load is exactly what queue depth explains (jobs spending longer in `waiting` before a worker slot frees up).
- **Max/avg queue depth** is the direct evidence of backpressure: with 1 worker, 8 concurrency slots must absorb up to 1600 branch nodes becoming ready near-simultaneously (8-wide fan-out x 200 runs) — expect a deep, slow-draining queue. With 4 workers the same burst is spread across 32 slots, so the queue should drain visibly faster and the p95 should be markedly lower.