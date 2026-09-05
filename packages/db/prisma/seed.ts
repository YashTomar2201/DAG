/**
 * Roadmap A3, step 6 — seeds a dev tenant + API key so `docker compose up`
 * still gives a working demo out of the box, the same way the pre-A3
 * `?tenantId=default` shim always "just worked" with no setup.
 *
 * Idempotent: safe to run on every container start (the `migrate` one-shot
 * service runs it after every `migrate deploy`) — it upserts the tenant and
 * only creates the key if a row with its hash doesn't already exist.
 *
 * The raw key is fixed (`DEV_API_KEY`, overridable via env) rather than
 * randomly generated, because a real API key can only be shown once by
 * design — a fixed dev value is what lets `apps/web`'s build bake in a
 * working `VITE_API_KEY` without a manual "copy the key from the logs" step.
 * This is a local-dev convenience, not something a real deployment should
 * copy: a production seed would generate a random key and print it once.
 */
import { createHash } from 'crypto';
import { PrismaClient } from '../src/generated/client';

const DEV_TENANT_ID = 'default';
const DEV_API_KEY = process.env['DEV_API_KEY'] ?? 'dev-key-local-only';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.tenant.upsert({
      where: { id: DEV_TENANT_ID },
      update: {},
      create: { id: DEV_TENANT_ID, name: 'Default (dev)' },
    });

    const hash = createHash('sha256').update(DEV_API_KEY).digest('hex');
    const existing = await prisma.apiKey.findUnique({ where: { hash } });
    if (existing) {
      console.log(`[seed] Dev API key already exists for tenant "${DEV_TENANT_ID}".`);
      return;
    }

    await prisma.apiKey.create({
      data: { tenantId: DEV_TENANT_ID, name: 'dev seed key', hash },
    });
    console.log(`[seed] Seeded dev API key for tenant "${DEV_TENANT_ID}": ${DEV_API_KEY}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
