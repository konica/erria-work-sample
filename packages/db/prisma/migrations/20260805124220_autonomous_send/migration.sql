-- AlterEnum
ALTER TYPE "TriggerStatus" ADD VALUE 'sequence_ended';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "relationshipSummaryUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "autonomousPauseReason" TEXT,
ADD COLUMN     "autonomousSendingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "triggers" ADD COLUMN     "hasComplianceDeadlineContent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vessels" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
