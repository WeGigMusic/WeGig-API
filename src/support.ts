import { Router } from "express";
import { requireAuth, type AuthedRequest } from "./auth";
import {
  canUseSandbox,
  googleAccountId,
  requireProduct,
  SupportError,
} from "./supportPolicy";
import {
  recordSupportPurchase,
  getSupporterStatus,
} from "./supportLedger";
import { verifySupportPurchase } from "./supportVerification";

const router = Router();

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(requireAuth);

router.use((req: AuthedRequest, res, next) => {
  const publicPayments =
    process.env.SUPPORT_PAYMENTS_ENABLED === "true";

  const testAccess =
    process.env.SUPPORT_TEST_PAYMENTS_ENABLED === "true" &&
    canUseSandbox(req.user!.id);

  if (
    process.env.SUPPORT_NOTIFICATIONS_ENABLED !== "true" ||
    (!publicPayments && !testAccess)
  ) {
    return res.status(503).json({
      code: "SUPPORT_NOT_AVAILABLE",
      message: "Support payments aren't available yet.",
    });
  }

  next();
});

// Limit verification work without logging credentials or purchase payloads.
const recent = new Map<string, { count: number; until: number }>();

router.use((req: AuthedRequest, res, next) => {
  const now = Date.now();

  for (const [id, entry] of recent) {
    if (entry.until <= now) recent.delete(id);
  }

  const id = req.user!.id;
  const entry = recent.get(id) ?? {
    count: 0,
    until: now + 60000,
  };

  entry.count += 1;
  recent.set(id, entry);

  if (entry.count > 30) {
    return res.status(429).json({
      code: "TOO_MANY_REQUESTS",
      message: "Please try again shortly.",
    });
  }

  next();
});

router.get("/status", async (req: AuthedRequest, res) => {
  try {
    const userId = req.user!.id;

    return res.json({
      ...await getSupporterStatus(userId),
      appleAppAccountToken: userId,
      googleObfuscatedAccountId: googleAccountId(userId),
    });
  } catch {
    return res.status(503).json({
      message: "Support status is unavailable. Please try again later.",
    });
  }
});

router.post("/verify", async (req: AuthedRequest, res) => {
  try {
    const {
      platform,
      productId,
      transactionId,
      purchaseToken,
    } = req.body ?? {};

    const proof: unknown =
      platform === "apple" ? transactionId : purchaseToken;

    if (
      (platform !== "apple" && platform !== "google") ||
      typeof productId !== "string" ||
      typeof proof !== "string" ||
      !proof.trim() ||
      proof.length > 4096
    ) {
      throw new SupportError(400, "INVALID_PURCHASE_REQUEST");
    }

    requireProduct(platform, productId);

    const userId = req.user!.id;
    const purchase = await verifySupportPurchase(userId, {
      platform,
      productId,
      proof,
    });

    if (
      process.env.SUPPORT_PAYMENTS_ENABLED !== "true" &&
      purchase.environment !== "sandbox"
    ) {
      throw new SupportError(403, "TEST_PURCHASE_REQUIRED");
    }

    await recordSupportPurchase(userId, purchase);

    // Finish or consume the transaction only after this response.
    return res.json({
      verified: true,
      environment: purchase.environment,
      ...await getSupporterStatus(userId),
    });
  } catch (error) {
    const providerError = error as {
      response?: { status?: number };
    };

    console.warn("[support/verify] failure", {
      platform: req.body?.platform === "google" ? "google" : "apple",
      code: error instanceof SupportError
        ? error.code
        : "PROVIDER_OR_INTERNAL_ERROR",
      providerStatus: providerError.response?.status ?? null,
    });

    if (error instanceof SupportError) {
      return res.status(error.status).json({
        code: error.code,
        message:
          error.code === "PAYMENT_PENDING"
            ? "Your payment is awaiting approval."
            : "We couldn't confirm this contribution.",
      });
    }

    // Provider exceptions may contain purchase tokens.
    return res.status(503).json({
      code: "PURCHASE_VERIFICATION_UNAVAILABLE",
      message:
        "We couldn't confirm your payment yet. Please try again later.",
    });
  }
});

export default router;