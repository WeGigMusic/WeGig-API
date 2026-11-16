import { createHash } from "node:crypto";
import { isSupportProduct, SupportError, type SupportEnvironment, type SupportPlatform } from "./supportPolicy";

export type RefundEvent = {
  platform: SupportPlatform;
  environment: SupportEnvironment;
  transactionKey: string;
  productId: string;
  eventAt: Date;
  revokedAt: Date | null;
};
function timestamp(value: unknown): Date {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) throw new SupportError(400, "INVALID_EVENT_DATE");
  const ms = Number(value);
  const date = new Date(ms);
  if (!Number.isSafeInteger(ms) || ms <= 0 || !Number.isFinite(date.getTime()) || ms > Date.now() + 300000) throw new SupportError(400, "INVALID_EVENT_DATE");
  return date;
}
// Inputs here must already have passed Apple's JWS verification.
export function appleRefundEvent(notification: {
  notificationType?: string; signedDate?: number;
}, transaction: {
  transactionId?: string; productId?: string; type?: string; quantity?: number; revocationDate?: number;
}, environment: SupportEnvironment): RefundEvent | null {
  if (!["REFUND", "REVOKE", "REFUND_REVERSED"].includes(notification.notificationType ?? "")) return null;
  if (!transaction.productId || !isSupportProduct("apple", transaction.productId)) return null;
  if (transaction.type !== "Consumable" || transaction.quantity !== 1 || !/^\d{1,40}$/.test(transaction.transactionId ?? "")) throw new SupportError(400, "INVALID_REFUND_TRANSACTION");
  const eventAt = timestamp(notification.signedDate);
  const reversed = notification.notificationType === "REFUND_REVERSED";
  const revokedAt = reversed ? null : timestamp(transaction.revocationDate);
  return { platform: "apple", environment, transactionKey: transaction.transactionId!, productId: transaction.productId, eventAt, revokedAt };
}
export type GoogleNotification = {
  packageName?: string; eventTimeMillis?: string;
  voidedPurchaseNotification?: { purchaseToken?: string; productType?: number; refundType?: number };
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
};
export function googleRefundToken(notification: GoogleNotification): string | null {
  if (notification.packageName !== "com.wegig.app") throw new SupportError(400, "WRONG_APPLICATION");
  let token: unknown;
  if (notification.voidedPurchaseNotification) {
    const voided = notification.voidedPurchaseNotification;
    if (voided.productType !== 2) return null;
    if (voided.refundType !== 1 && voided.refundType !== 2) throw new SupportError(400, "UNKNOWN_REFUND_TYPE");
    token = voided.purchaseToken;
  } else if (notification.oneTimeProductNotification?.notificationType === 2) {
    if (!isSupportProduct("google", notification.oneTimeProductNotification.sku ?? "")) return null;
    token = notification.oneTimeProductNotification.purchaseToken;
  } else return null;
  if (typeof token !== "string" || !token.trim() || token.length > 4096) throw new SupportError(400, "INVALID_PURCHASE_TOKEN");
  return token;
}
// The Google response is read directly from Android Publisher, not the push body.
export function googleRefundEvent(notification: GoogleNotification, token: string, purchase: {
  productLineItem?: Array<{ productId?: string; productOfferDetails?: { quantity?: number; refundableQuantity?: number } }>;
  purchaseStateContext?: { purchaseState?: string }; testPurchaseContext?: unknown;
}): RefundEvent | null {
  const item = purchase.productLineItem?.[0];
  if (!item?.productId || !isSupportProduct("google", item.productId)) return null;
  if (purchase.productLineItem?.length !== 1 || item.productOfferDetails?.quantity !== 1) throw new SupportError(400, "INVALID_REFUND_TRANSACTION");
  if (notification.oneTimeProductNotification?.sku && notification.oneTimeProductNotification.sku !== item.productId) throw new SupportError(400, "PURCHASE_PRODUCT_MISMATCH");
  // Pending cancellations must not remove a different, completed contribution.
  // Full void notifications are themselves authoritative; for cancellation and
  // partial-quantity events wait until Publisher confirms no paid quantity remains.
  const fullVoid = notification.voidedPurchaseNotification?.productType === 2 && notification.voidedPurchaseNotification.refundType === 1;
  const revoked = fullVoid || purchase.purchaseStateContext?.purchaseState === "CANCELLED" || item.productOfferDetails?.refundableQuantity === 0;
  if (!revoked) throw new SupportError(503, "REFUND_STATE_NOT_READY");
  const eventAt = timestamp(notification.eventTimeMillis);
  return { platform: "google", environment: purchase.testPurchaseContext ? "sandbox" : "production", transactionKey: createHash("sha256").update(token).digest("hex"), productId: item.productId, eventAt, revokedAt: eventAt };
}
export function shouldApplyRefund(previous: { eventAt: Date; revokedAt: Date | null } | null, event: RefundEvent): boolean {
  if (!previous) return true;
  if (event.eventAt.getTime() !== previous.eventAt.getTime()) return event.eventAt > previous.eventAt;
  // At an equal timestamp a revocation wins; a replay cannot restore a refund.
  return previous.revokedAt === null && event.revokedAt !== null;
}

export function requireGooglePushIdentity(claims: {
  email?: string; email_verified?: boolean; aud?: string | string[]; iss?: string;
} | undefined, audience: string, email: string): void {
  if (claims?.email !== email || claims.email_verified !== true || claims.aud !== audience || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")) {
    throw new SupportError(401, "INVALID_PUSH_IDENTITY");
  }
}
