/**
 * Roadmap C2.1 — the transaction-scoped tenant context Postgres RLS checks.
 *
 * A row-security policy reads `current_setting('app.tenant_id', true)` per
 * query. That setting only means anything if it's set with `set_config(...,
 * true)` — the `true` there is Postgres's "is_local" flag, meaning the value
 * is scoped to the CURRENT TRANSACTION and vanishes on commit/rollback. That
 * matters because this app's `PrismaClient` pools connections: a plain
 * (non-local) `SET` would stick on whatever physical connection happened to
 * serve this call, and a later, unrelated request could reuse that same
 * connection and inherit the wrong tenant. Every RLS-protected read or write
 * in this codebase goes through `withTenant()` (or, for the couple of
 * genuinely cross-tenant operations, `withAdminContext()`) for exactly this
 * reason — never a bare `prisma.<model>.<op>()` against Workflow, Run,
 * NodeRun, or RunEvent.
 *
 * Each call opens its own short transaction scoped to that one operation
 * (or the few operations one repository function needs) — not one big
 * transaction wrapping a whole request. The independent atomic
 * conditional-updates this codebase relies on for its concurrency
 * guarantees (`tryTransitionNodeRun`, `tryTransitionRun`) need to keep
 * committing independently; wrapping an entire multi-step orchestrator flow
 * in one transaction would change those semantics, not just add RLS.
 */
import { prisma } from './client';
import type { Prisma } from './generated/client';

export type Db = Prisma.TransactionClient;

/** Never derived from caller input — see the module doc comment. */
const ADMIN_SENTINEL = '__dag_admin__';

async function runWithTenantSetting<T>(value: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${value}, true)`;
    return fn(tx);
  });
}

/** Runs `fn` inside a transaction scoped to `tenantId` — RLS makes every query inside see only that tenant's rows. */
export function withTenant<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return runWithTenantSetting(tenantId, fn);
}

/**
 * Runs `fn` with the RLS bypass sentinel. Reserved for the small, fixed set
 * of operations that must legitimately see every tenant at once: the
 * Prometheus aggregate counts (`countNodeRunsByStatus`/`countRunsByStatus`)
 * and resolving which tenant owns a workflow/run before any tenant context
 * is known yet (`getWorkflowTenantId`/`resolveTenantForRun`). Every call
 * site is in this package, hardcoded — never reachable from a request value.
 */
export function withAdminContext<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return runWithTenantSetting(ADMIN_SENTINEL, fn);
}
