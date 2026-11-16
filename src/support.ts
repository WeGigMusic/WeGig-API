import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "./prisma";
import { requireAuth, type AuthedRequest } from "./auth";
import { canUseSandbox, googleAccountId, requireProduct, SupportError } from "./supportPolicy";
import { verifySupportPurchase } from "./supportVerification";

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  if (process.env.SUPPORT_PAYMENTS_ENABLED !== "true") {
    return res.status(503).json({ code: "SUPPORT_NOT_AVAILABLE", message: "Support payments aren't available yet." });
  }
  next();
});
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// Limit verification work without retaining credentials or purchase payloads in logs.
const recent = new Map<string, { count: number; until: number }>();
router.use((req: AuthedRequest, res, next) => {
  const now = Date.now();
  for (const [id, entry] of recent) if (entry.until <= now) recent.delete(id);
  const id = req.user!.id;
  const entry = recent.get(id) ?? { count: 0, until: now + 60000 };
  entry.count += 1;
  recent.set(id, entry);
  if (entry.count > 30) return res.status(429).json({ code: "TOO_MANY_REQUESTS", message: "Please try again shortly." });
  next();
});

async function status(userId: string) {
  const purchases = await prisma.supportPurchase.findMany({
    where: { userId, environment: { in: canUseSandbox(userId) ? ["production", "sandbox"] : ["production"] } },
    select: { environment: true },
    distinct: ["environment"],
  });
  const isFoundingSupporter = purchases.some((purchase) => purchase.environment === "production");
  return { isFoundingSupporter, isTestSupporter: !isFoundingSupporter && purchases.some((purchase) => purchase.environment === "sandbox") };
}

router.get("/status", async (req: AuthedRequest, res) => {
  try {
    const userId = req.user!.id;
    return res.json({ ...await status(userId), appleAppAccountToken: userId, googleObfuscatedAccountId: googleAccountId(userId) });
  } catch {
    return res.status(503).json({ message: "Support status is unavailable. Please try again later." });
  }
});

router.post("/verify", async (req: AuthedRequest, res) => {
  try {
    const { platform, productId, transactionId, purchaseToken } = req.body ?? {};
    const proof: unknown = platform === "apple" ? transactionId : purchaseToken;
    if ((platform !== "apple" && platform !== "google") || typeof productId !== "string" || typeof proof !== "string" || !proof.trim() || proof.length > 4096) {
      throw new SupportError(400, "INVALID_PURCHASE_REQUEST");
    }
    requireProduct(platform, productId);
    const userId = req.user!.id;
    const purchase = await verifySupportPurchase(userId, { platform, productId, proof });
    try {
      await prisma.supportPurchase.create({ data: { ...purchase, userId } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const existing = await prisma.supportPurchase.findUnique({ where: { platform_environment_transactionKey: { platform: purchase.platform, environment: purchase.environment, transactionKey: purchase.transactionKey } } });
      if (!existing || existing.userId !== userId || existing.productId !== productId) throw new SupportError(409, "PURCHASE_ALREADY_CLAIMED");
    }
    // The client may finish/consume the transaction only after this response.
    return res.json({ verified: true, environment: purchase.environment, ...await status(userId) });
  } catch (error) {
    if (error instanceof SupportError) return res.status(error.status).json({ code: error.code, message: error.code === "PAYMENT_PENDING" ? "Your payment is awaiting approval." : "We couldn't confirm this contribution." });
    // Never log provider exceptions: Google errors may include the purchase token in the URL.
    return res.status(503).json({ code: "PURCHASE_VERIFICATION_UNAVAILABLE", message: "We couldn't confirm your payment yet. Please try again later." });
  }
});

export default router;
