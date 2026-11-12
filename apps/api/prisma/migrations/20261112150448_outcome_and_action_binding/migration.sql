-- DropIndex
DROP INDEX "Approval_actionId_approverId_key";

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Investigation" ADD COLUMN     "outcome" TEXT;

-- AlterTable
ALTER TABLE "RemediationAction" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "effect" TEXT NOT NULL DEFAULT 'state_changing',
ADD COLUMN     "effectReasons" JSONB;

-- CreateIndex
CREATE INDEX "Approval_actionId_idx" ON "Approval"("actionId");
