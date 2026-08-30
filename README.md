# Distributed Visual Workflow (DAG) Engine

A distributed, highly concurrent execution engine for visually building, validating, and
running Directed Acyclic Graph (DAG) workflows — a lightweight, purpose-built alternative to
Apache Airflow / AWS Step Functions. See [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) for the full
design, and [`knowledge_base/`](knowledge_base/) for the architecture write-up, decision log,
tech primer, and interview Q&A generated as the project was built.

## Quickstart

Requires Docker (with Compose v2) and nothing else.

```bash
git clone <this-repo>
cd DAG
docker compose -f infra/docker-compose.yml up --build --scale worker=4 -d
```

This builds and starts: Postgres, Redis, a one-shot migration runner, the API (control plane),
**4** worker processes (data plane), and the visual editor. Wait for the API to report healthy
(`docker compose -f infra/docker-compose.yml ps` — `api` should show `healthy`), then open:

```
http://localhost:5173
```

Drag out a pipeline (or use the API directly — see below), click **Run**, and watch the nodes
light up live via Server-Sent Events. The run's timeline (`GET /runs/:id`) will show different
`workerId` values across nodes once you have more than one worker replica — that's the
horizontal-scaling claim, observable directly, not just asserted.

To scale workers up or down without touching any config:

```bash
docker compose -f infra/docker-compose.yml up -d --scale worker=8
```

To tear everything down (add `-v` to also delete the Postgres/Redis/artifact volumes):

```bash
docker compose -f infra/docker-compose.yml down
```

### Running it without Docker

For local development with hot reload, see [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) §0 — briefly:
`docker compose -f infra/docker-compose.yml up -d postgres redis`, `pnpm install`,
`pnpm --filter @dag/db db:migrate:deploy`, then `pnpm dev` from the repo root.

## Testing and benchmarks

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test   # fast, mocked unit suite
pnpm --filter @dag/api test:integration             # real Postgres + Redis (Testcontainers)
pnpm --filter @dag/api scale-test                    # load test — writes benchmarks/phase-12-scale-test.md
```

See [`knowledge_base/architecture.md`](knowledge_base/architecture.md) for what each suite
proves and why, and [`benchmarks/phase-12-scale-test.md`](benchmarks/phase-12-scale-test.md)
for the current horizontal-scaling numbers.

## Repository layout

See [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) §3 for the full layout and the rules each part
follows (e.g. `packages/graph-core` has zero runtime dependencies so the exact same cycle-
detection code runs in the browser and on the server).
