const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const policy = require("../dist/supportPolicy");

test("Apple fallback stays restricted to authorised sandbox testers", async () => {
  const user = "11111111-1111-4111-8111-111111111111";
  const productId = "com.wegig.mobile.support.small";
  const names = [
    "IAP_TEST_USER_IDS", "APPLE_IAP_PRIVATE_KEY_PATH",
    "APPLE_IAP_KEY_ID", "APPLE_IAP_ISSUER_ID", "APPLE_IAP_APP_ID"
  ];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const source = fs.readFileSync(
    path.join(__dirname, "../dist/supportVerification.js"), "utf8"
  );

  try {
    for (const name of names) process.env[name] = "test";
    process.env.APPLE_IAP_APP_ID = "6778116125";

    for (const status of [401, 404, 403, 429, 500]) {
      for (const allowed of [false, true]) {
        process.env.IAP_TEST_USER_IDS = allowed ? user : "";
        const calls = [];
        class APIException extends Error {}
        class Client {
          constructor(_key, _id, _issuer, _bundle, environment) {
            this.environment = environment;
          }
          async getTransactionInfo() {
            calls.push(this.environment);
            if (this.environment === "production") {
              const error = new APIException();
              error.httpStatusCode = status;
              throw error;
            }
            return { signedTransactionInfo: "mock-signed-transaction" };
          }
        }
        class Verifier {
          async verifyAndDecodeTransaction() {
            return {
              transactionId: "123", productId, type: "consumable",
              quantity: 1, appAccountToken: user,
              purchaseDate: Date.now()
            };
          }
        }

        const module = { exports: {} };
        vm.runInNewContext(source, {
          exports: module.exports, module, process,
          require(name) {
            if (name === "node:fs") return { readFileSync: () => "mock-key" };
            if (name === "./supportPolicy") return policy;
            if (name === "@apple/app-store-server-library") return {
              APIException, AppStoreServerAPIClient: Client,
              SignedDataVerifier: Verifier,
              Environment: { PRODUCTION: "production", SANDBOX: "sandbox" },
              Type: { CONSUMABLE: "consumable" }
            };
            return require(name);
          }
        });

        const verify = () => module.exports.verifySupportPurchase(user, {
          platform: "apple", productId, proof: "123"
        });
        if (allowed && [401, 404].includes(status)) {
          assert.equal((await verify()).environment, "sandbox");
          assert.deepEqual(calls, ["production", "sandbox"]);
        } else {
          await assert.rejects(verify, APIException);
          assert.deepEqual(calls, ["production"]);
        }
      }
    }
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});