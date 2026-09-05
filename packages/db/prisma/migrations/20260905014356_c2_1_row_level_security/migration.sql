-- Roadmap C2.1 — Postgres Row-Level Security.
--
-- Four parts, in order:
--   1. Denormalise `tenantId` onto Run/NodeRun/RunEvent and backfill it from
--      the existing Workflow.tenantId (via WorkflowVersion -> Workflow, and
--      NodeRun/RunEvent -> Run). RLS policies live per-table and can't reach
--      through a join, so this column has to exist directly on every table
--      a policy protects.
--   2. Create a restricted, NON-superuser role (`dag_app`) for the API and
--      worker to connect as at runtime. This step is not optional: the `dag`
--      role this project's Postgres containers bootstrap with (via
--      POSTGRES_USER) is a superuser, and Postgres row security policies are
--      silently bypassed for superusers and table owners, REGARDLESS of what
--      policies exist. Enabling RLS while the app still connects as `dag`
--      would look like it works and protect nothing.
--   3. Enable RLS on Workflow/Run/NodeRun/RunEvent with one policy per table:
--      a row is visible (and, for INSERT, only insertable) when its tenantId
--      matches `current_setting('app.tenant_id', true)` for the current
--      transaction — see packages/db/src/tenant.ts's `withTenant()`, which
--      sets that value via `set_config(..., true)` (`true` = LOCAL, i.e.
--      scoped to one transaction, never leaking onto a pooled connection's
--      next, unrelated query). Unset ⇒ NULL ⇒ every comparison is UNKNOWN ⇒
--      every row is hidden — fail CLOSED by default, not open.
--   4. A single carve-out sentinel (`__dag_admin__`) for the handful of
--      operations that must legitimately see every tenant at once: the
--      Prometheus aggregate counts, and resolving which tenant owns a runId
--      before the tenant context needed to look anything else up is even
--      known (`withAdminContext()` in the same file). This is intentionally
--      NOT a second Postgres role/BYPASSRLS grant — that would make bypass
--      all-or-nothing per connection. A sentinel checked in the policy
--      expression itself means only this codebase's own two call sites can
--      ever request it; nothing a caller sends (a tenantId always comes from
--      a verified ApiKey lookup or this fixed literal) can reach it.
--
-- WorkflowVersion is deliberately NOT included — see KNOWN_LIMITATIONS.md and
-- decisions_log.md's C2.1 section for why, and what that leaves open.

-- ─── Part 1: add + backfill + require tenantId ──────────────────────────────

ALTER TABLE "Run" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "NodeRun" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "RunEvent" ADD COLUMN "tenantId" TEXT;

UPDATE "Run" r
SET "tenantId" = w."tenantId"
FROM "WorkflowVersion" wv
JOIN "Workflow" w ON w.id = wv."workflowId"
WHERE wv.id = r."workflowVersionId";

UPDATE "NodeRun" nr
SET "tenantId" = r."tenantId"
FROM "Run" r
WHERE r.id = nr."runId";

UPDATE "RunEvent" re
SET "tenantId" = r."tenantId"
FROM "Run" r
WHERE r.id = re."runId";

ALTER TABLE "Run" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "NodeRun" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "RunEvent" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX "Run_tenantId_idx" ON "Run"("tenantId");
CREATE INDEX "NodeRun_tenantId_idx" ON "NodeRun"("tenantId");
CREATE INDEX "RunEvent_tenantId_idx" ON "RunEvent"("tenantId");

-- ─── Part 2: the restricted application role ────────────────────────────────
--
-- Password is a fixed dev-only value, same posture as every other credential
-- already committed in this repo (infra/docker-compose.yml's postgres/redis
-- passwords, the A3 dev API key) — a real deployment provisions this role
-- through infra-as-code / a secrets manager, never a checked-in migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dag_app') THEN
    CREATE ROLE dag_app WITH LOGIN PASSWORD 'dag_app_secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- `current_database()` rather than a literal name: this migration also runs
-- against the integration suite's throwaway Testcontainers database (a
-- different name/bootstrap user than production's `dag_engine`/`dag`) —
-- `GRANT ... ON DATABASE` doesn't accept a function call directly, so this
-- needs one level of dynamic SQL.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dag_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO dag_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dag_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dag_app;
-- No `FOR ROLE <name>` clause: that defaults to the CURRENT role (whoever is
-- running this migration — `dag` in production, a different bootstrap user
-- in the integration suite's throwaway container), which is exactly right
-- since migrations always run as that same role in both places. So a table
-- created by a FUTURE migration grants dag_app access automatically, with no
-- follow-up GRANT migration needed.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dag_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dag_app;

-- ─── Part 3: enable RLS + the tenant-isolation policy ───────────────────────

ALTER TABLE "Workflow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NodeRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RunEvent" ENABLE ROW LEVEL SECURITY;

-- No FOR clause: the same USING expression governs SELECT/UPDATE/DELETE
-- visibility AND (as the implicit WITH CHECK) which new rows INSERT is
-- allowed to create — an INSERT whose tenantId doesn't match the active
-- session's is rejected, not silently written into someone else's tenant.
CREATE POLICY tenant_isolation ON "Workflow"
  USING ("tenantId" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '__dag_admin__');

CREATE POLICY tenant_isolation ON "Run"
  USING ("tenantId" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '__dag_admin__');

CREATE POLICY tenant_isolation ON "NodeRun"
  USING ("tenantId" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '__dag_admin__');

CREATE POLICY tenant_isolation ON "RunEvent"
  USING ("tenantId" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '__dag_admin__');
