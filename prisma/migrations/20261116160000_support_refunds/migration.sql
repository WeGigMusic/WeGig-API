ALTER TABLE "SupportPurchase" ADD COLUMN "revokedAt" TIMESTAMP(3);
CREATE TABLE "SupportStoreState" (
  "platform" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "transactionKey" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "eventAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "SupportStoreState_pkey" PRIMARY KEY ("platform", "environment", "transactionKey"),
  CONSTRAINT "SupportStoreState_platform_check" CHECK ("platform" IN ('apple', 'google')),
  CONSTRAINT "SupportStoreState_environment_check" CHECK ("environment" IN ('production', 'sandbox'))
);
