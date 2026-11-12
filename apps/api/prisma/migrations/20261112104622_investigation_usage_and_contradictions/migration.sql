-- Records which engine wrote each investigation and what it used, and the evidence against
-- each hypothesis. (The generated statement dropping the vector index was removed on review.)

-- AlterTable
ALTER TABLE "Hypothesis" ADD COLUMN     "contradictingRefs" TEXT[],
ADD COLUMN     "contradictions" TEXT[];

-- AlterTable
ALTER TABLE "Investigation" ADD COLUMN     "analysisMode" TEXT,
ADD COLUMN     "attemptedProvider" TEXT,
ADD COLUMN     "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "estimatedCostUsd" DOUBLE PRECISION,
ADD COLUMN     "llmCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "llmLatencyMs" INTEGER NOT NULL DEFAULT 0;
