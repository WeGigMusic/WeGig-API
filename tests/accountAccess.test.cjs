const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

test("account deletion requires valid authentication and supports restricted retries", async () => {
  const jose = await import("jose");
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "ES256";

  const user = "11111111-1111-4111-8111-111111111111";
  const previousUrl = process.env.SUPABASE_URL;
  const modulePath = require.resolve("../dist/accountDeletion");
  const previousModule = require.cache[modulePath];
  let deleting = false;
  let databaseUnavailable = false;
  const deletedUsers = [];

  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      isAccountDeletionRequested: async () => {
        if (databaseUnavailable) throw new Error("Test database failure");
        return deleting;
      },
      AccountDeletionError: class extends Error {},
      deleteAccount: async id => {
        deletedUsers.push(id);
        deleting = true;
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.get("/auth/v1/.well-known/jwks.json", (_req, res) => {
    res.json({ keys: [jwk] });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_URL = origin;

  try {
    const { requireAuth } = require("../dist/auth");
    const accountRouter = require("../dist/account").default;
    app.get("/normal", requireAuth, (req, res) => {
      res.json({ userId: req.user.id });
    });
    app.use("/account", accountRouter);

    const token = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setSubject(user)
      .setIssuer(`${origin}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const remove = body => fetch(origin + "/account", {
      method: "DELETE", headers, body: JSON.stringify(body),
    });

    assert.equal((await fetch(origin + "/normal")).status, 401);
    assert.equal((await fetch(origin + "/normal", {
      headers: { Authorization: "Bearer forged-token" },
    })).status, 401);
    assert.equal((await fetch(origin + "/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    })).status, 401);
    assert.equal((await fetch(origin + "/normal", { headers })).status, 200);

    databaseUnavailable = true;
    assert.equal((await fetch(origin + "/normal", { headers })).status, 503);
    databaseUnavailable = false;

    assert.equal((await remove({ confirmation: "wrong" })).status, 400);
    assert.equal(deletedUsers.length, 0);

    // The request body cannot choose somebody else's account.
    assert.equal((await remove({
      confirmation: "DELETE", userId: "another-user",
    })).status, 200);
    assert.deepEqual(deletedUsers, [user]);

    assert.equal((await fetch(origin + "/normal", { headers })).status, 403);
    assert.equal((await remove({ confirmation: "DELETE" })).status, 200);
    assert.deepEqual(deletedUsers, [user, user]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  }
});