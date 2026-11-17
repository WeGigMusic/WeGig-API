import type { Request, Response, NextFunction } from "express";
import { isAccountDeletionRequested } from "./accountDeletion";

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is not set in the API environment");
}

export type AuthedRequest = Request & {
  user?: {
    id: string;
    email?: string;
  };
};

let josePromise: Promise<any> | null = null;
let jwksPromise: Promise<any> | null = null;

async function getJose() {
  if (!josePromise) {
    josePromise = import("jose");
  }
  return josePromise;
}

async function getJwks() {
  if (!jwksPromise) {
    jwksPromise = (async () => {
      const { createRemoteJWKSet } = await getJose();
      return createRemoteJWKSet(
        new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
      );
    })();
  }
  return jwksPromise;
}

async function authenticate(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
  allowDeletionRetry: boolean,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing bearer token" });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({ message: "Missing bearer token" });
  }

  let user: NonNullable<AuthedRequest["user"]>;

  try {
    const { jwtVerify } = await getJose();
    const JWKS = await getJwks();

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: "authenticated",
    });

    if (typeof payload.sub !== "string" || !payload.sub) {
      return res.status(401).json({ message: "Invalid token subject" });
    }

    user = {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }

  if (!allowDeletionRetry) {
    try {
      if (await isAccountDeletionRequested(user.id)) {
        return res.status(403).json({
          code: "ACCOUNT_DELETION_REQUESTED",
          message: "This account is being deleted.",
        });
      }
    } catch {
      return res.status(503).json({
        message: "Account access is temporarily unavailable.",
      });
    }
  }

  req.user = user;
  return next();
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  return authenticate(req, res, next, false);
}

// Use only on the account-deletion endpoint.
export function requireAccountDeletionAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  return authenticate(req, res, next, true);
}