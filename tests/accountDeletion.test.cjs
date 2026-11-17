const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const user = "11111111-1111-4111-8111-111111111111";
const hash = createHash("sha256").update(user).digest("hex");

function acceptedDeletion() {
  return {
    persons_found: 1,
    persons_deleted: 0,
    persons_queued_for_deletion: 1,
    events_queued_for_deletion: true,
    recordings_queued_for_deletion: true,
    deletion_errors: [],
  };
}

function setup(options = {}) {
  const events = [];
  const state = {
    requested: false,
    completed: false,
  };

  const controls = {
    authStatus: 200,
    posthogStatus: 202,
    posthogBody: acceptedDeletion(),
    posthogNetworkFailure: false,
    posthogInvalidJson: false,
    ...options,
  };

  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-supabase-key",
    POSTHOG_HOST: "https://eu.posthog.com",
    POSTHOG_PROJECT_ID: "170798",
    POSTHOG_PERSONAL_API_KEY: "test-only-posthog-key",
    ...(options.env || {}),
  };

  const tx = {
    $queryRaw: async (...args) => {
      events.push(["lock", args.slice(1)]);
    },
    accountDeletion: {
      upsert: async (args) => {
        events.push(["marker", args]);
        state.requested = true;
      },
    },
    gig: {
      deleteMany: async (args) => {
        events.push(["gigs", args]);
      },
    },
    supportPurchase: {
      updateMany: async (args) => {
        events.push(["purchases", args]);
      },
    },
  };

  const prisma = {
    $transaction: async (action) => action(tx),
    accountDeletion: {
      findUnique: async () =>
        state.requested ? { userIdHash: hash } : null,
      update: async (args) => {
        events.push(["completed", args]);
        state.completed = true;
      },
    },
  };

  async function fakeFetch(url, requestOptions) {
    if (
      url ===
      "https://eu.posthog.com/api/projects/170798/persons/bulk_delete/"
    ) {
      events.push(["posthog", { url, options: requestOptions }]);

      if (controls.posthogNetworkFailure) {
        throw new Error("Simulated network failure");
      }

      return {
        status: controls.posthogStatus,
        ok:
          controls.posthogStatus >= 200 &&
          controls.posthogStatus < 300,
        json: async () => {
          if (controls.posthogInvalidJson) {
            throw new Error("Simulated invalid JSON");
          }
          return controls.posthogBody;
        },
      };
    }

    if (
      url ===
      `https://example.supabase.co/auth/v1/admin/users/${user}`
    ) {
      events.push(["auth", { url, options: requestOptions }]);

      return {
        status: controls.authStatus,
        ok:
          controls.authStatus >= 200 &&
          controls.authStatus < 300,
      };
    }

    throw new Error("Unexpected network request");
  }

  const modules = new Map();

  function loadModule(filename) {
    if (modules.has(filename)) {
      return modules.get(filename).exports;
    }

    const loadedModule = { exports: {} };
    modules.set(filename, loadedModule);

    vm.runInNewContext(
      fs.readFileSync(
        path.join(__dirname, "../dist", filename),
        "utf8",
      ),
      {
        module: loadedModule,
        exports: loadedModule.exports,
        process: { env },
        AbortSignal,
        fetch: fakeFetch,
        require(name) {
          if (name === "./prisma") {
            return {
              __esModule: true,
              default: prisma,
            };
          }

          if (name === "./posthogDeletion") {
            return loadModule("posthogDeletion.js");
          }

          if (name === "node:crypto") {
            return require(name);
          }

          throw new Error(`Unexpected module: ${name}`);
        },
      },
    );

    return loadedModule.exports;
  }

  return {
    api: loadModule("accountDeletion.js"),
    events,
    state,
    controls,
  };
}

function retryRequired(error) {
  return (
    error.status === 503 &&
    error.code === "ACCOUNT_DELETION_RETRY_REQUIRED"
  );
}

test("deletion targets the user, detaches purchases and requests analytics deletion before Auth deletion", async () => {
  const { api, events, state } = setup();

  assert.equal(await api.isAccountDeletionRequested(user), false);

  await api.deleteAccount(user);

  assert.deepEqual(
    events.map((event) => event[0]),
    [
      "lock",
      "marker",
      "gigs",
      "purchases",
      "posthog",
      "auth",
      "completed",
    ],
  );

  assert.equal(events[0][1][0], `account-deletion:${hash}`);
  assert.equal(events[1][1].create.userIdHash, hash);
  assert.equal(events[2][1].where.userId, user);
  assert.equal(events[3][1].where.userId, user);
  assert.equal(events[3][1].data.userId, null);

  const posthogRequest = events[4][1];

  assert.equal(posthogRequest.options.method, "POST");
  assert.equal(
    posthogRequest.options.headers.Authorization,
    "Bearer test-only-posthog-key",
  );
  assert.equal(posthogRequest.options.redirect, "error");
  assert.deepEqual(
    JSON.parse(posthogRequest.options.body),
    {
      distinct_ids: [user],
      delete_events: true,
      delete_recordings: true,
      keep_person: false,
    },
  );

  assert.equal(
    events[5][1].url,
    `https://example.supabase.co/auth/v1/admin/users/${user}`,
  );
  assert.equal(events[5][1].options.method, "DELETE");
  assert.deepEqual(
    JSON.parse(events[5][1].options.body),
    { should_soft_delete: false },
  );

  assert.equal(state.completed, true);
  assert.equal(await api.isAccountDeletionRequested(user), true);
});

test("missing or invalid credentials stop deletion before data changes", async () => {
  const invalidConfigurations = [
    { SUPABASE_URL: "" },
    { SUPABASE_SERVICE_ROLE_KEY: "" },
    { POSTHOG_HOST: "" },
    { POSTHOG_HOST: "https://unexpected.example" },
    { POSTHOG_PROJECT_ID: "" },
    { POSTHOG_PROJECT_ID: "invalid" },
    { POSTHOG_PERSONAL_API_KEY: "" },
  ];

  for (const env of invalidConfigurations) {
    const { api, events } = setup({ env });

    await assert.rejects(
      () => api.deleteAccount(user),
      (error) =>
        error.status === 503 &&
        error.code === "ACCOUNT_DELETION_NOT_CONFIGURED",
    );

    assert.equal(events.length, 0);
  }
});

test("PostHog failure preserves the marker and prevents Auth deletion", async () => {
  const failures = [
    { posthogStatus: 401 },
    { posthogStatus: 503 },
    { posthogNetworkFailure: true },
    { posthogInvalidJson: true },
    { posthogBody: {} },
    {
      posthogBody: {
        ...acceptedDeletion(),
        deletion_errors: [{ step: "delete_person" }],
      },
    },
    {
      posthogBody: {
        ...acceptedDeletion(),
        persons_queued_for_deletion: 0,
      },
    },
    {
      posthogBody: {
        ...acceptedDeletion(),
        events_queued_for_deletion: false,
      },
    },
    {
      posthogBody: {
        ...acceptedDeletion(),
        recordings_queued_for_deletion: false,
      },
    },
  ];

  for (const failure of failures) {
    const { api, events, state } = setup(failure);

    await assert.rejects(
      () => api.deleteAccount(user),
      retryRequired,
    );

    assert.equal(state.requested, true);
    assert.equal(state.completed, false);
    assert.equal(
      events.some((event) => event[0] === "auth"),
      false,
    );
  }
});

test("retry succeeds after a temporary PostHog failure", async () => {
  const { api, events, state, controls } = setup({
    posthogStatus: 503,
  });

  await assert.rejects(
    () => api.deleteAccount(user),
    retryRequired,
  );

  controls.posthogStatus = 202;

  await api.deleteAccount(user);

  assert.equal(state.completed, true);
  assert.equal(
    events.filter((event) => event[0] === "posthog").length,
    2,
  );
  assert.equal(
    events.filter((event) => event[0] === "auth").length,
    1,
  );
});

test("an account with no matching PostHog person can still be deleted", async () => {
  const { api, state } = setup({
    posthogBody: {
      persons_found: 0,
      persons_deleted: 0,
      persons_queued_for_deletion: 0,
      events_queued_for_deletion: false,
      recordings_queued_for_deletion: false,
      deletion_errors: [],
    },
  });

  await api.deleteAccount(user);

  assert.equal(state.completed, true);
});

test("Auth failure preserves the deletion marker for retry", async () => {
  const { api, state, controls } = setup({
    authStatus: 503,
  });

  await assert.rejects(
    () => api.deleteAccount(user),
    retryRequired,
  );

  assert.equal(state.requested, true);
  assert.equal(state.completed, false);

  controls.authStatus = 200;

  await api.deleteAccount(user);

  assert.equal(state.completed, true);
});

test("retry can finish when the Auth user was already removed", async () => {
  const { api, state } = setup({ authStatus: 404 });

  await api.deleteAccount(user);
  await api.deleteAccount(user);

  assert.equal(state.requested, true);
  assert.equal(state.completed, true);
});