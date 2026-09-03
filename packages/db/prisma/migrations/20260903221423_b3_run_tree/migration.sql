-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "fanOutIndex" INTEGER,
ADD COLUMN     "parentRunId" TEXT;

-- CreateIndex
CREATE INDEX "Run_parentRunId_status_idx" ON "Run"("parentRunId", "status");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
