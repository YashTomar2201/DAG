-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "concurrencyLimit" INTEGER NOT NULL DEFAULT 20;
