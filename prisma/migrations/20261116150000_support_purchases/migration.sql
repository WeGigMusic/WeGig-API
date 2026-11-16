CREATE TABLE "SupportPurchase" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "transactionKey" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportPurchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportPurchase_platform_check" CHECK ("platform" IN ('apple', 'google')),
  CONSTRAINT "SupportPurchase_environment_check" CHECK ("environment" IN ('production', 'sandbox'))
);
CREATE UNIQUE INDEX "SupportPurchase_platform_environment_transactionKey_key" ON "SupportPurchase"("platform", "environment", "transactionKey");
CREATE INDEX "SupportPurchase_userId_environment_idx" ON "SupportPurchase"("userId", "environment");
