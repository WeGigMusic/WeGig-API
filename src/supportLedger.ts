import type { Prisma } from "@prisma/client";
import prisma from "./prisma";
import { canUseSandbox, SupportError, type VerifiedSupportPurchase } from "./supportPolicy";
import { shouldApplyRefund, type RefundEvent } from "./supportRefundPolicy";

type Identity = Pick<VerifiedSupportPurchase, "platform" | "environment" | "transactionKey">;
async function lock(tx: Prisma.TransactionClient, identity: Identity) {
  const key = `${identity.platform}:${identity.environment}:${identity.transactionKey}`;
  // Shared by verification and notifications. This serialises one purchase even
  // if a refund reaches us before its purchase record has been created.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export async function recordSupportPurchase(userId: string, purchase: VerifiedSupportPurchase): Promise<void> {
  await prisma.$transaction(async tx => {
    await lock(tx, purchase);
    const identity = { platform: purchase.platform, environment: purchase.environment, transactionKey: purchase.transactionKey };
    const state = await tx.supportStoreState.findUnique({ where: { platform_environment_transactionKey: identity } });
    if (state?.revokedAt) throw new SupportError(409, "PURCHASE_REFUNDED");
    if (state && state.productId !== purchase.productId) throw new SupportError(409, "PURCHASE_PRODUCT_MISMATCH");
    const existing = await tx.supportPurchase.findUnique({ where: { platform_environment_transactionKey: identity } });
    if (existing) {
      if (existing.userId !== userId || existing.productId !== purchase.productId) throw new SupportError(409, "PURCHASE_ALREADY_CLAIMED");
      if (existing.revokedAt) throw new SupportError(409, "PURCHASE_REFUNDED");
    } else await tx.supportPurchase.create({ data: { ...purchase, userId } });
  }, { maxWait: 5000, timeout: 10000 });
}
export async function applySupportRefund(event: RefundEvent): Promise<boolean> {
  return prisma.$transaction(async tx => {
    await lock(tx, event);
    const identity = { platform: event.platform, environment: event.environment, transactionKey: event.transactionKey };
    const previous = await tx.supportStoreState.findUnique({ where: { platform_environment_transactionKey: identity } });
    if (previous && previous.productId !== event.productId) throw new SupportError(409, "PURCHASE_PRODUCT_MISMATCH");
    if (!shouldApplyRefund(previous, event)) return false;
    await tx.supportStoreState.upsert({ where: { platform_environment_transactionKey: identity }, create: event, update: { eventAt: event.eventAt, revokedAt: event.revokedAt } });
    await tx.supportPurchase.updateMany({ where: { ...identity, productId: event.productId }, data: { revokedAt: event.revokedAt } });
    return true;
  }, { maxWait: 5000, timeout: 10000 });
}

export async function getSupporterStatus(userId: string) {
  const purchases = await prisma.supportPurchase.findMany({
    where: { userId, revokedAt: null, environment: { in: canUseSandbox(userId) ? ["production", "sandbox"] : ["production"] } },
    select: { environment: true }, distinct: ["environment"],
  });
  const isFoundingSupporter = purchases.some(purchase => purchase.environment === "production");
  return { isFoundingSupporter, isTestSupporter: !isFoundingSupporter && purchases.some(purchase => purchase.environment === "sandbox") };
}
