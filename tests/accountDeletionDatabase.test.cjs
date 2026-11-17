const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { Pool } = require("pg");

const target = process.env.SUPPORT_TEST_DATABASE_URL;
if (!target) throw new Error("Set a dedicated local SUPPORT_TEST_DATABASE_URL.");
const url = new URL(target);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !url.pathname.endsWith("_test")
) {
  throw new Error("Only a local database ending in _test is permitted.");
}

test("deletion blocks concurrent writes and preserves detached refund records", async () => {
  const pool = new Pool({ connectionString: target });
  const owner = randomUUID();
  const other = randomUUID();
  const hash = createHash("sha256").update(owner).digest("hex");
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const txKey = randomUUID();
  const deletion = await pool.connect();
  const writer = await pool.connect();
  let pending;

  const addGig = (client, id, user) => client.query(
    `INSERT INTO "Gig"
      ("id","userId","artist","venue","city","date","updatedAt")
     VALUES ($1,$2,'Test artist','Test venue','Test city','2026-11-17',NOW())`,
    [id, user]
  );

  try {
    await addGig(pool, ids[0], owner);
    await addGig(pool, ids[1], other);
    await pool.query(
      `INSERT INTO "SupportPurchase"
       ("id","userId","platform","environment","transactionKey","productId","purchasedAt")
       VALUES ($1,$2,'apple','sandbox',$3,'com.wegig.mobile.support.small',NOW())`,
      [ids[2], owner, txKey]
    );

    await deletion.query("BEGIN");
    await deletion.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`account-deletion:${hash}`]
    );
    await deletion.query(
      `INSERT INTO "AccountDeletion" ("userIdHash") VALUES ($1)`,
      [hash]
    );

    // This write must wait for deletion's exclusive account lock.
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = addGig(writer, ids[3], owner).then(
      () => null,
      error => error
    );

    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await pool.query(
        "SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid]
      );
      if (result.rows[0]?.wait_event === "advisory") {
        waiting = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, "Concurrent write must wait on account lock");

    await deletion.query(`DELETE FROM "Gig" WHERE "userId"=$1`, [owner]);
    await deletion.query(
      `UPDATE "SupportPurchase" SET "userId"=NULL WHERE "userId"=$1`,
      [owner]
    );
    await deletion.query("COMMIT");

    const rejected = await pending;
    assert.equal(rejected?.code, "23514");

    await assert.rejects(
      () => pool.query(
        `UPDATE "Gig" SET "userId"=$1 WHERE "id"=$2`, [owner, ids[1]]
      ),
      error => error.code === "23514"
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "SupportPurchase"
         ("id","userId","platform","environment","transactionKey","productId","purchasedAt")
         VALUES ($1,$2,'apple','sandbox',$3,'com.wegig.mobile.support.small',NOW())`,
        [ids[4], owner, randomUUID()]
      ),
      error => error.code === "23514"
    );

    await pool.query(
      `UPDATE "SupportPurchase" SET "revokedAt"=NOW() WHERE "id"=$1`,
      [ids[2]]
    );
    const purchase = (await pool.query(
      `SELECT * FROM "SupportPurchase" WHERE "id"=$1`, [ids[2]]
    )).rows[0];
    assert.equal(purchase.userId, null);
    assert.equal(purchase.transactionKey, txKey);
    assert.ok(purchase.revokedAt);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Gig" WHERE "userId"=$1`, [owner]
    )).rows[0].count, 0);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Gig" WHERE "userId"=$1`, [other]
    )).rows[0].count, 1);
  } finally {
    await deletion.query("ROLLBACK");
    if (pending) await pending;
    deletion.release();
    writer.release();
    await pool.query(`DELETE FROM "Gig" WHERE "id"=ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM "SupportPurchase" WHERE "id"=ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM "AccountDeletion" WHERE "userIdHash"=$1`, [hash]);
    await pool.end();
  }
});
