import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APIException, AppStoreServerAPIClient, Environment, SignedDataVerifier, Type } from "@apple/app-store-server-library";
import { GoogleAuth } from "google-auth-library";
import { canUseSandbox, checkGooglePurchase, requireProduct, SupportError, type VerifiedSupportPurchase } from "./supportPolicy";

export function requiredSupportSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new SupportError(503, "PAYMENTS_NOT_CONFIGURED");
  return value;
}

async function verifyApple(userId: string, productId: string, transactionId: string): Promise<VerifiedSupportPurchase> {
  requireProduct("apple", productId);
  if (!/^\d{1,40}$/.test(transactionId)) throw new SupportError(400, "INVALID_TRANSACTION_ID");
  const bundleId = "com.wegig.mobile";
  const privateKey = readFileSync(requiredSupportSetting("APPLE_IAP_PRIVATE_KEY_PATH"), "utf8");
  const keyId = requiredSupportSetting("APPLE_IAP_KEY_ID");
  const issuerId = requiredSupportSetting("APPLE_IAP_ISSUER_ID");
  let environment = Environment.PRODUCTION;
  let response;
  const client = (target: Environment) => new AppStoreServerAPIClient(privateKey, keyId, issuerId, bundleId, target);
  try {
    response = await client(environment).getTransactionInfo(transactionId);
  } catch (error) {
    if (!(error instanceof APIException) || error.httpStatusCode !== 404 || !canUseSandbox(userId)) throw error;
    environment = Environment.SANDBOX;
    response = await client(environment).getTransactionInfo(transactionId);
  }
  if (!response.signedTransactionInfo) throw new SupportError(400, "INVALID_STORE_RESPONSE");
  const verifier = appleSignedDataVerifier(environment);
  const transaction = await verifier.verifyAndDecodeTransaction(response.signedTransactionInfo);
  if (transaction.transactionId !== transactionId || transaction.productId !== productId || transaction.type !== Type.CONSUMABLE || transaction.quantity !== 1) {
    throw new SupportError(400, "PURCHASE_PRODUCT_MISMATCH");
  }
  if (transaction.appAccountToken?.toLowerCase() !== userId.toLowerCase()) throw new SupportError(403, "PURCHASE_ACCOUNT_MISMATCH");
  if (transaction.revocationDate != null) throw new SupportError(400, "PURCHASE_REFUNDED");
  const purchasedAt = new Date(transaction.purchaseDate ?? NaN);
  if (!Number.isFinite(purchasedAt.getTime())) throw new SupportError(400, "INVALID_PURCHASE_DATE");
  return { platform: "apple", environment: environment === Environment.SANDBOX ? "sandbox" : "production", transactionKey: transactionId, productId, purchasedAt };
}

async function verifyGoogle(userId: string, productId: string, token: string): Promise<VerifiedSupportPurchase> {
  requireProduct("google", productId);
  return checkGooglePurchase(await lookupGooglePurchase(token), userId, productId, token);
}

export function appleSignedDataVerifier(environment: Environment): SignedDataVerifier {
  const roots = ["AppleRootCA-G3.cer", "AppleIncRootCertificate.cer"].map(file => readFileSync(resolve(process.cwd(), "certs/apple", file)));
  const appAppleId = Number(requiredSupportSetting("APPLE_IAP_APP_ID"));
  if (!Number.isSafeInteger(appAppleId) || appAppleId <= 0) throw new SupportError(503, "PAYMENTS_NOT_CONFIGURED");
  return new SignedDataVerifier(roots, true, environment, "com.wegig.mobile", appAppleId);
}

export async function lookupGooglePurchase(token: string): Promise<Parameters<typeof checkGooglePurchase>[0]> {
  const auth = new GoogleAuth({ keyFile: requiredSupportSetting("GOOGLE_PLAY_SERVICE_ACCOUNT_PATH"), scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
  const client = await auth.getClient();
  const response = await client.request<Parameters<typeof checkGooglePurchase>[0]>({
    url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.wegig.app/purchases/productsv2/tokens/${encodeURIComponent(token)}`,
    method: "GET", timeout: 15000, retry: false,
  });
  return response.data;
}

export async function verifySupportPurchase(userId: string, input: { platform: "apple" | "google"; productId: string; proof: string }): Promise<VerifiedSupportPurchase> {
  return input.platform === "apple" ? verifyApple(userId, input.productId, input.proof) : verifyGoogle(userId, input.productId, input.proof);
}
