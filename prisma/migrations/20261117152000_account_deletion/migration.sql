ALTER TABLE "SupportPurchase"
ALTER COLUMN "userId" DROP NOT NULL;

CREATE TABLE "AccountDeletion" (
  "userIdHash" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("userIdHash")
);

CREATE FUNCTION "guard_account_deletion_writes"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_hash TEXT;
BEGIN
  -- Refund updates to detached purchase records remain permitted.
  IF NEW."userId" IS NULL THEN
    RETURN NEW;
  END IF;

  account_hash :=
    encode(sha256(convert_to(NEW."userId", 'UTF8')), 'hex');

  -- Account deletion takes the exclusive version of this lock.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('account-deletion:' || account_hash, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM "AccountDeletion"
    WHERE "userIdHash" = account_hash
  ) THEN
    RAISE EXCEPTION 'Account deletion has been requested'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Gig_guard_account_deletion"
BEFORE INSERT OR UPDATE ON "Gig"
FOR EACH ROW
EXECUTE FUNCTION "guard_account_deletion_writes"();

CREATE TRIGGER "SupportPurchase_guard_account_deletion"
BEFORE INSERT OR UPDATE ON "SupportPurchase"
FOR EACH ROW
EXECUTE FUNCTION "guard_account_deletion_writes"();