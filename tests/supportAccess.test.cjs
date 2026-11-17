const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const policy = require("../dist/supportPolicy");

test("support test access blocks other users and production purchases", async () => {
  const user = "11111111-1111-4111-8111-111111111111";
  const names = [
    "SUPPORT_PAYMENTS_ENABLED",
    "SUPPORT_TEST_PAYMENTS_ENABLED",
    "SUPPORT_NOTIFICATIONS_ENABLED",
    "IAP_TEST_USER_IDS"
  ];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  let environment = "sandbox";
  let records = 0;
  const module = { exports: {} };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../dist/support.js"), "utf8"),
    {
      exports: module.exports, module, process,
      require(name) {
        if (name === "./auth") return {
          requireAuth(req, _res, next) {
            req.user = { id: req.headers["x-test-user"] || user };
            next();
          }
        };
        if (name === "./supportPolicy") return policy;
        if (name === "./supportLedger") return {
          recordSupportPurchase: async () => { records++; },
          getSupporterStatus: async () => ({})
        };
        if (name === "./supportVerification") return {
          verifySupportPurchase: async () => ({ environment })
        };
        return require(name);
      }
    }
  );

  const app = express();
  app.use(express.json());
  app.use("/support", module.exports.default);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/support`;

  try {
    process.env.IAP_TEST_USER_IDS = user;
    process.env.SUPPORT_PAYMENTS_ENABLED = "false";
    process.env.SUPPORT_TEST_PAYMENTS_ENABLED = "true";
    process.env.SUPPORT_NOTIFICATIONS_ENABLED = "true";

    assert.equal((await fetch(url + "/status")).status, 200);
    assert.equal((await fetch(url + "/status", {
      headers: { "x-test-user": "another-user" }
    })).status, 503);

    process.env.SUPPORT_TEST_PAYMENTS_ENABLED = "false";
    assert.equal((await fetch(url + "/status")).status, 503);
    process.env.SUPPORT_TEST_PAYMENTS_ENABLED = "true";

    process.env.SUPPORT_NOTIFICATIONS_ENABLED = "false";
    assert.equal((await fetch(url + "/status")).status, 503);
    process.env.SUPPORT_NOTIFICATIONS_ENABLED = "true";

    const verify = () => fetch(url + "/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "apple",
        productId: "com.wegig.mobile.support.small",
        transactionId: "123"
      })
    });

    environment = "production";
    const rejected = await verify();
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "TEST_PURCHASE_REQUIRED");
    assert.equal(records, 0);

    environment = "sandbox";
    assert.equal((await verify()).status, 200);
    assert.equal(records, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});