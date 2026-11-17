import { createHash } from "node:crypto";
import prisma from "./prisma";
import {
  getPostHogDeletionConfig,
  requestPostHogDeletion,
} from "./posthogDeletion";

export class AccountDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function accountUserHash(userId: string): string {
  return createHash("sha256")
    .update(userId, "utf8")
    .digest("hex");
}

export async function isAccountDeletionRequested(
  userId: string,
): Promise<boolean> {
  const entry = await prisma.accountDeletion.findUnique({
    where: {
      userIdHash: accountUserHash(userId),
    },
    select: {
      userIdHash: true,
    },
  });

  return entry !== null;
}

export async function deleteAccount(userId: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  // Validate external service configuration before changing account data.
  if (!supabaseUrl || !serviceKey) {
    throw new AccountDeletionError(
      503,
      "ACCOUNT_DELETION_NOT_CONFIGURED",
    );
  }

  let posthogConfig: ReturnType<typeof getPostHogDeletionConfig>;

  try {
    posthogConfig = getPostHogDeletionConfig();
  } catch {
    throw new AccountDeletionError(
      503,
      "ACCOUNT_DELETION_NOT_CONFIGURED",
    );
  }

  const userIdHash = accountUserHash(userId);
  const lockKey = `account-deletion:${userIdHash}`;

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;

      await tx.accountDeletion.upsert({
        where: {
          userIdHash,
        },
        create: {
          userIdHash,
        },
        update: {},
      });

      await tx.gig.deleteMany({
        where: {
          userId,
        },
      });

      // Retain transaction identity and refund state without the account link.
      await tx.supportPurchase.updateMany({
        where: {
          userId,
        },
        data: {
          userId: null,
        },
      });
    },
    {
      maxWait: 5000,
      timeout: 15000,
    },
  );

  // PostHog processes accepted deletion requests asynchronously.
  // Request deletion before removing the sign-in account so a failure
  // leaves the user able to retry through the restricted deletion route.
  try {
    await requestPostHogDeletion(userId, posthogConfig);
  } catch {
    throw new AccountDeletionError(
      503,
      "ACCOUNT_DELETION_RETRY_REQUIRED",
    );
  }

  // Keep the deletion marker if this call fails, so retries remain possible
  // and the account cannot resume normal API access.
  let response: Response;

  try {
    response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          should_soft_delete: false,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new AccountDeletionError(
      503,
      "ACCOUNT_DELETION_RETRY_REQUIRED",
    );
  }

  // A previous attempt may already have deleted the Auth user.
  if (!response.ok && response.status !== 404) {
    throw new AccountDeletionError(
      503,
      "ACCOUNT_DELETION_RETRY_REQUIRED",
    );
  }

  // This marks the account flow complete. PostHog's accepted deletion
  // request may still be processing in the background.
  await prisma.accountDeletion.update({
    where: {
      userIdHash,
    },
    data: {
      completedAt: new Date(),
    },
  });
}