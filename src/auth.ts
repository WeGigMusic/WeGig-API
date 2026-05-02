import type { Request, Response, NextFunction } from "express";

const supabaseUrl = process.env.SUPABASE_URL;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is not set in the API .env");
}

export type AuthedRequest = Request & {
  user?: {
    id: string;
    email?: string;
  };
};

let jwksPromise: Promise<ReturnType<any>> | null = null;

async function getJose() {
  return await import("jose");
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

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Missing bearer token" });
    }

    const token = authHeader.slice("Bearer ".length);

    const { jwtVerify } = await getJose();
    const JWKS = await getJwks();

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${supabaseUrl}/auth/v1`,
    });

    req.user = {
      id: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
    };

    next();
  } catch (error) {
    console.error("Auth verification failed:", error);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}