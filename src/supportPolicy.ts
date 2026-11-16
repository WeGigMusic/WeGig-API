import { createHash } from "node:crypto";

export const SUPPORT_KEYS = ["small", "medium", "large", "extra1", "extra20", "extra50", "extra100"] as const;
export type SupportPlatform = "apple" | "google";
export type SupportEnvironment = "production" | "sandbox";
export type VerifiedSupportPurchase = {
  platform: SupportPlatform;
  environment: SupportEnvironment;
  transactionKey: string;
  productId: string;
  purchasedAt: Date;
};

export class SupportError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function googleAccountId(userId: string): string {
  return createHash("sha256").update(`wegig-support:${userId}`).digest("hex");
}

export function isSupportProduct(platform: SupportPlatform, productId: string): boolean {
  const prefix = platform === "apple" ? "com.wegig.mobile.support." : "com.wegig.app.support.";
  return SUPPORT_KEYS.some((key) => productId === prefix + key);
}

export function canUseSandbox(userId: string): boolean {
  return (process.env.IAP_TEST_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean).includes(userId);
}

export function requireProduct(platform: SupportPlatform, productId: string): void {
  if (!isSupportProduct(platform, productId)) throw new SupportError(400, "UNKNOWN_SUPPORT_PRODUCT");
}

export function checkGooglePurchase(data: {
  purchaseStateContext?: { purchaseState?: string };
  obfuscatedExternalAccountId?: string;
  productLineItem?: Array<{ productId?: string; productOfferDetails?: { quantity?: number; refundableQuantity?: number } }>;
  purchaseCompletionTime?: string;
  testPurchaseContext?: unknown;
}, userId: string, productId: string, token: string): VerifiedSupportPurchase {
  requireProduct("google", productId);
  if (data.purchaseStateContext?.purchaseState === "PENDING") throw new SupportError(409, "PAYMENT_PENDING");
  if (data.purchaseStateContext?.purchaseState !== "PURCHASED") throw new SupportError(400, "PAYMENT_NOT_PURCHASED");
  if (data.obfuscatedExternalAccountId !== googleAccountId(userId)) throw new SupportError(403, "PURCHASE_ACCOUNT_MISMATCH");
  const items = data.productLineItem ?? [];
  const item = items[0];
  if (items.length !== 1 || item.productId !== productId || item.productOfferDetails?.quantity !== 1) {
    throw new SupportError(400, "PURCHASE_PRODUCT_MISMATCH");
  }
  if (item.productOfferDetails?.refundableQuantity === 0) throw new SupportError(400, "PURCHASE_REFUNDED");
  const purchasedAt = new Date(data.purchaseCompletionTime ?? "");
  if (!Number.isFinite(purchasedAt.getTime())) throw new SupportError(400, "INVALID_PURCHASE_DATE");
  const environment = data.testPurchaseContext ? "sandbox" : "production";
  if (environment === "sandbox" && !canUseSandbox(userId)) throw new SupportError(403, "TEST_PURCHASE_NOT_ALLOWED");
  return { platform: "google", environment, productId, purchasedAt, transactionKey: createHash("sha256").update(token).digest("hex") };
}
