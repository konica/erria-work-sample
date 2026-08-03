-- CreateEnum
CREATE TYPE "IcpBand" AS ENUM ('high', 'med', 'low');

-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('crm', 'class_records', 'public_data', 'buyer_reply');

-- CreateEnum
CREATE TYPE "ConfidenceLabel" AS ENUM ('high', 'mid', 'low');

-- CreateEnum
CREATE TYPE "TriggerStatus" AS ENUM ('new', 'processing', 'drafted', 'superseded', 'needs_triage');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('agent_draft', 'agent_sent', 'buyer_inbound', 'system_note', 'human_reply');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'sent', 'needs_triage');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('email');

-- CreateEnum
CREATE TYPE "HardTriggerRule" AS ENUM ('pricing_question', 'technical_compliance_question', 'negative_sentiment', 'relationship_conflict', 'compliance_deadline_content', 'non_english_language', 'conflicting_signals', 'classification_uncertain');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('active', 'resolved');

-- CreateEnum
CREATE TYPE "ResolutionActionType" AS ENUM ('mark_resolved', 'compose_send');

-- CreateEnum
CREATE TYPE "OutcomeTag" AS ENUM ('closed_won', 're_engaged', 'no_response', 'churned', 'closed_no_action');

-- CreateEnum
CREATE TYPE "TierHistoryEventType" AS ENUM ('create', 'clean_approval', 'promote', 'demote', 'escalate', 'hold_at_tier', 'current_draft', 'manual_override');

-- CreateEnum
CREATE TYPE "AuditReviewStatus" AS ENUM ('unreviewed', 'fine', 'concerning');

-- CreateEnum
CREATE TYPE "SentimentFloor" AS ENUM ('Low', 'Medium', 'High');

-- CreateEnum
CREATE TYPE "LlmCallPurpose" AS ENUM ('draft_generation', 'hard_trigger_classification');

-- CreateEnum
CREATE TYPE "LlmCallOutcome" AS ENUM ('success', 'retried_success', 'timeout', 'error');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT,
    "companyName" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "hub" TEXT NOT NULL,
    "icpScore" INTEGER NOT NULL,
    "icpBand" "IcpBand" NOT NULL,
    "relationshipSummary" TEXT NOT NULL,
    "currentTier" INTEGER NOT NULL,
    "tierRationale" TEXT NOT NULL,
    "cleanApprovalsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vessels" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imo" TEXT NOT NULL,
    "flag" TEXT NOT NULL,

    CONSTRAINT "vessels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vesselId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" "TriggerSource" NOT NULL,
    "confidenceLabel" "ConfidenceLabel" NOT NULL,
    "verifiabilityNote" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "status" "TriggerStatus" NOT NULL DEFAULT 'new',

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "triggerId" TEXT,
    "escalationId" TEXT,
    "role" "MessageRole" NOT NULL,
    "body" TEXT NOT NULL,
    "originalBody" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "status" "MessageStatus" NOT NULL,
    "tierContext" INTEGER NOT NULL,
    "confidenceMeta" JSONB,
    "hardRuleFlags" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "channel" "MessageChannel" NOT NULL DEFAULT 'email',
    "isFollowup" BOOLEAN,
    "followupSequenceNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "triggerMessageId" TEXT,
    "hardTriggerRule" "HardTriggerRule" NOT NULL,
    "reasonSummary" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "recommendedNextStep" TEXT NOT NULL,
    "recommendedNextStepEdited" TEXT,
    "agentSendDisabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "EscalationStatus" NOT NULL DEFAULT 'active',
    "repeatOfResolutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolutions" (
    "id" TEXT NOT NULL,
    "escalationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "actionType" "ResolutionActionType" NOT NULL,
    "actionTaken" TEXT NOT NULL,
    "followupMessageId" TEXT,
    "followupSentAt" TIMESTAMP(3),
    "outcomeTag" "OutcomeTag" NOT NULL,
    "resolvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_history_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "eventType" "TierHistoryEventType" NOT NULL,
    "fromTier" INTEGER,
    "toTier" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "relatedMessageId" TEXT,
    "relatedEscalationId" TEXT,

    CONSTRAINT "tier_history_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_samples" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewStatus" "AuditReviewStatus" NOT NULL DEFAULT 'unreviewed',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "audit_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tier1PromotionThreshold" INTEGER NOT NULL DEFAULT 2,
    "tier1AuditSampleRate" INTEGER NOT NULL DEFAULT 10,
    "maxFollowups" INTEGER NOT NULL DEFAULT 2,
    "minDaysBetweenFollowups" INTEGER NOT NULL DEFAULT 5,
    "sentimentConfidenceFloor" "SentimentFloor" NOT NULL DEFAULT 'Medium',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "purpose" "LlmCallPurpose" NOT NULL,
    "accountId" TEXT,
    "messageId" TEXT,
    "modelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestTokens" INTEGER NOT NULL,
    "responseTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "outcome" "LlmCallOutcome" NOT NULL,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_externalRef_key" ON "accounts"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_imo_key" ON "vessels"("imo");

-- CreateIndex
CREATE INDEX "vessels_accountId_idx" ON "vessels"("accountId");

-- CreateIndex
CREATE INDEX "contacts_accountId_idx" ON "contacts"("accountId");

-- CreateIndex
CREATE INDEX "triggers_accountId_idx" ON "triggers"("accountId");

-- CreateIndex
CREATE INDEX "triggers_vesselId_idx" ON "triggers"("vesselId");

-- CreateIndex
CREATE INDEX "messages_accountId_idx" ON "messages"("accountId");

-- CreateIndex
CREATE INDEX "messages_triggerId_idx" ON "messages"("triggerId");

-- CreateIndex
CREATE INDEX "messages_escalationId_idx" ON "messages"("escalationId");

-- CreateIndex
CREATE INDEX "escalations_accountId_idx" ON "escalations"("accountId");

-- CreateIndex
CREATE INDEX "escalations_repeatOfResolutionId_idx" ON "escalations"("repeatOfResolutionId");

-- CreateIndex
CREATE UNIQUE INDEX "resolutions_escalationId_key" ON "resolutions"("escalationId");

-- CreateIndex
CREATE INDEX "resolutions_accountId_idx" ON "resolutions"("accountId");

-- CreateIndex
CREATE INDEX "resolutions_followupMessageId_idx" ON "resolutions"("followupMessageId");

-- CreateIndex
CREATE INDEX "tier_history_events_accountId_idx" ON "tier_history_events"("accountId");

-- CreateIndex
CREATE INDEX "tier_history_events_relatedMessageId_idx" ON "tier_history_events"("relatedMessageId");

-- CreateIndex
CREATE INDEX "tier_history_events_relatedEscalationId_idx" ON "tier_history_events"("relatedEscalationId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_samples_messageId_key" ON "audit_samples"("messageId");

-- CreateIndex
CREATE INDEX "audit_samples_accountId_idx" ON "audit_samples"("accountId");

-- CreateIndex
CREATE INDEX "llm_calls_accountId_idx" ON "llm_calls"("accountId");

-- CreateIndex
CREATE INDEX "llm_calls_messageId_idx" ON "llm_calls"("messageId");

-- AddForeignKey
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_escalationId_fkey" FOREIGN KEY ("escalationId") REFERENCES "escalations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_repeatOfResolutionId_fkey" FOREIGN KEY ("repeatOfResolutionId") REFERENCES "resolutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_escalationId_fkey" FOREIGN KEY ("escalationId") REFERENCES "escalations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_followupMessageId_fkey" FOREIGN KEY ("followupMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_history_events" ADD CONSTRAINT "tier_history_events_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_history_events" ADD CONSTRAINT "tier_history_events_relatedMessageId_fkey" FOREIGN KEY ("relatedMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_history_events" ADD CONSTRAINT "tier_history_events_relatedEscalationId_fkey" FOREIGN KEY ("relatedEscalationId") REFERENCES "escalations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_samples" ADD CONSTRAINT "audit_samples_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_samples" ADD CONSTRAINT "audit_samples_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
