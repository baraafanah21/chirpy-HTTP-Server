import crypto from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import type { Request } from "express";

import { UnauthorizedError } from "./errors.js";

const TOKEN_ISSUER = "chirpy";

type payload = Pick<JwtPayload, "iss" | "sub" | "iat" | "exp">;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function checkPasswordHash(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash (e.g. the "unset" default) makes verify throw.
    // That's a failed login, not a server error.
    return false;
  }
}

export function makeJWT(
  userID: string,
  expiresIn: number,
  secret: string,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const token: payload = {
    iss: TOKEN_ISSUER,
    sub: userID,
    iat: issuedAt,
    exp: issuedAt + expiresIn,
  };

  return jwt.sign(token, secret);
}

export function validateJWT(tokenString: string, secret: string): string {
  let decoded: payload;

  try {
    decoded = jwt.verify(tokenString, secret) as payload;
  } catch {
    throw new UnauthorizedError("Invalid token");
  }

  if (decoded.iss !== TOKEN_ISSUER) {
    throw new UnauthorizedError("Invalid token issuer");
  }

  if (!decoded.sub) {
    throw new UnauthorizedError("Invalid token: no user ID");
  }

  return decoded.sub;
}

export function makeRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getBearerToken(req: Request): string {
  return getAuthorizationValue(req, "Bearer");
}

export function getAPIKey(req: Request): string {
  return getAuthorizationValue(req, "ApiKey");
}

function getAuthorizationValue(req: Request, scheme: string): string {
  const header = req.get("Authorization");

  if (!header) {
    throw new UnauthorizedError("Missing Authorization header");
  }

  const match = header.match(new RegExp(`^${scheme}\\s+(\\S+)\\s*$`, "i"));

  if (!match?.[1]) {
    throw new UnauthorizedError("Malformed Authorization header");
  }

  return match[1];
}
