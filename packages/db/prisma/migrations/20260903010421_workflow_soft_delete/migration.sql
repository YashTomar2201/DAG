-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Workflow_tenantId_createdAt_idx" ON "Workflow"("tenantId", "createdAt");
