import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { Environment, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { safeErrorDetails } from "./safeError";
import { SupportError } from "./supportPolicy";
import { appleSignedDataVerifier, lookupGooglePurchase, requiredSupportSetting } from "./supportVerification";
import { applySupportRefund } from "./supportLedger";
import { appleRefundEvent, googleRefundEvent, googleRefundToken, requireGooglePushIdentity, type GoogleNotification } from "./supportRefundPolicy";

const oauth = new OAuth2Client();
const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  // This flag is independent of accepting new payments: existing refunds must
  // keep working when the payment screen is disabled.
  if (process.env.SUPPORT_NOTIFICATIONS_ENABLED !== "true") return res.sendStatus(503);
  next();
});

router.post("/apple/:environment", async (req, res) => {
  try {
    if (req.params.environment !== "production" && req.params.environment !== "sandbox") return res.sendStatus(404);
    const environment = req.params.environment === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
    const signedPayload: unknown = req.body?.signedPayload;
    if (typeof signedPayload !== "string" || signedPayload.length > 65536 || signedPayload.split(".").length !== 3) return res.sendStatus(400);
    // Do not decode untrusted JSON to choose the verifier/environment.
    const verifier = appleSignedDataVerifier(environment);
    const notification = await verifier.verifyAndDecodeNotification(signedPayload);
    if (!["REFUND", "REVOKE", "REFUND_REVERSED"].includes(notification.notificationType ?? "")) return res.sendStatus(204);
    if (!notification.data?.signedTransactionInfo) return res.sendStatus(400);
    const transaction = await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
    const event = appleRefundEvent(notification, transaction, req.params.environment);
    if (event) {
      const applied = await applySupportRefund(event);
      console.info("[support/notifications] refund", { platform: "apple", environment: event.environment, applied });
    }
    return res.sendStatus(204);
  } catch (error) {
    console.warn("[support/notifications] failure", {
      platform: "apple",
      ...(error instanceof SupportError ? { code: error.code, status: error.status } : safeErrorDetails(error)),
    });
    if (error instanceof VerificationException && error.status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) return res.sendStatus(401);
    if (error instanceof SupportError) return res.sendStatus(error.status);
    return res.sendStatus(503);
  }
});

router.post("/google", async (req, res) => {
  try {
    const audience = requiredSupportSetting("GOOGLE_PLAY_PUBSUB_AUDIENCE");
    const email = requiredSupportSetting("GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT");
    const subscription = requiredSupportSetting("GOOGLE_PLAY_PUBSUB_SUBSCRIPTION");
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 8192) return res.sendStatus(401);
    let claims;
    try { claims = (await oauth.verifyIdToken({ idToken: header.slice(7), audience })).getPayload(); }
    catch { return res.sendStatus(401); }
    requireGooglePushIdentity(claims, audience, email);
    if (req.body?.subscription !== subscription) return res.sendStatus(403);
    const data: unknown = req.body?.message?.data;
    if (typeof data !== "string" || !data.length || data.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return res.sendStatus(400);
    let notification: GoogleNotification;
    try { notification = JSON.parse(Buffer.from(data, "base64").toString("utf8")); }
    catch { return res.sendStatus(400); }
    if (!notification || typeof notification !== "object") return res.sendStatus(400);
    const token = googleRefundToken(notification);
    if (token) {
      const purchase = await lookupGooglePurchase(token);
      const event = googleRefundEvent(notification, token, purchase);
      if (event) {
        const applied = await applySupportRefund(event);
        console.info("[support/notifications] refund", { platform: "google", environment: event.environment, applied });
      } else {
        console.info("[support/notifications] Google refund skipped", { reason: "not_a_support_product" });
      }
    }
    // HTTP success acknowledges the message only after the DB transaction commits.
    return res.sendStatus(204);
  } catch (error) {
    console.warn("[support/notifications] failure", {
      platform: "google",
      ...(error instanceof SupportError ? { code: error.code, status: error.status } : safeErrorDetails(error)),
    });
    if (error instanceof SupportError) return res.sendStatus(error.status);
    return res.sendStatus(503);
  }
});
export default router;
