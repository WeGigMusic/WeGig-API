const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const user = "11111111-1111-4111-8111-111111111111";
const hash = createHash("sha256").update(user).digest("hex");

function setup(status = 200, configured = true) {
  const events = [];
  const state = { requested: false, completed: false };
  const env = configured ? {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  } : {};

  const tx = {
    $queryRaw: async (...args) => {
      events.push(["lock", args.slice(1)]);
    },
    accountDeletion: {
      upsert: async args => {
        events.push(["marker", args]);
        state.requested = true;
      },
    },
    gig: {
      deleteMany: async args => events.push(["gigs", args]),
    },
    supportPurchase: {
      updateMany: async args => events.push(["purchases", args]),
    },
  };

  const prisma = {
    $transaction: async action => action(tx),
    accountDeletion: {
      findUnique: async () =>
        state.requested ? { userIdHash: hash } : null,
      update: async args => {
        events.push(["completed", args]);
        state.completed = true;
      },
    },
  };

  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../dist/accountDeletion.js"), "utf8"
    ),
    {
      module,
      exports: module.exports,
      process: { env },
      AbortSignal,
      fetch: async (url, options) => {
        events.push(["auth", { url, options }]);
        return { ok: status >= 200 && status < 300, status };
      },
      require(name) {
        if (name === "./prisma") return { __esModule: true, default: prisma };
        return require(name);
      },
    }
  );

  return { api: module.exports, events, state };
}

test("deletion targets only the authenticated user and detaches purchases", async () => {
  const { api, events, state } = setup();
  assert.equal(await api.isAccountDeletionRequested(user), false);

  await api.deleteAccount(user);

  assert.deepEqual(events.map(e => e[0]), [
    "lock", "marker", "gigs", "purchases", "auth", "completed"
  ]);
  assert.equal(events[0][1][0], `account-deletion:${hash}`);
  assert.equal(events[1][1].create.userIdHash, hash);
  assert.equal(events[2][1].where.userId, user);
  assert.equal(events[3][1].where.userId, user);
  assert.equal(events[3][1].data.userId, null);
  assert.equal(
    events[4][1].url,
    `https://example.supabase.co/auth/v1/admin/users/${user}`
  );
  assert.equal(events[4][1].options.method, "DELETE");
  assert.equal(state.completed, true);
  assert.equal(await api.isAccountDeletionRequested(user), true);
});

test("missing credentials stop deletion before any data changes", async () => {
  const { api, events } = setup(200, false);
  await assert.rejects(
    () => api.deleteAccount(user),
    e => e.code === "ACCOUNT_DELETION_NOT_CONFIGURED"
  );
  assert.equal(events.length, 0);
});

test("Auth failure preserves the deletion marker for retry", async () => {
  const { api, state } = setup(503);
  await assert.rejects(
    () => api.deleteAccount(user),
    e => e.code === "ACCOUNT_DELETION_RETRY_REQUIRED"
  );
  assert.equal(state.requested, true);
  assert.equal(state.completed, false);
});

test("retry can finish when the Auth user was already removed", async () => {
  const { api, state } = setup(404);
  await api.deleteAccount(user);
  await api.deleteAccount(user);
  assert.equal(state.requested, true);
  assert.equal(state.completed, true);
});