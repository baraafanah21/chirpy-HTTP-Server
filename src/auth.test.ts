import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

import type { Request } from "express";

import {
  hashPassword,
  checkPasswordHash,
  makeJWT,
  validateJWT,
  getBearerToken,
} from "./auth.js";

// getBearerToken only ever calls req.get, so a stub of that is enough.
function makeReq(headers: Record<string, string>): Request {
  return {
    get: (name: string) => headers[name],
  } as unknown as Request;
}

describe("Password Hashing", () => {
  const password1 = "correctPassword123!";
  const password2 = "anotherPassword456!";
  let hash1: string;
  let hash2: string;

  beforeAll(async () => {
    hash1 = await hashPassword(password1);
    hash2 = await hashPassword(password2);
  });

  it("should return true for the correct password", async () => {
    const result = await checkPasswordHash(password1, hash1);
    expect(result).toBe(true);
  });

  it("should return false for the wrong password", async () => {
    const result = await checkPasswordHash(password2, hash1);
    expect(result).toBe(false);
  });

  it("should produce a different hash for each password", () => {
    expect(hash1).not.toBe(hash2);
  });

  it("should not store the password in plain text", () => {
    expect(hash1).not.toContain(password1);
  });

  it("should return false instead of throwing on a malformed hash", async () => {
    const result = await checkPasswordHash(password1, "unset");
    expect(result).toBe(false);
  });
});

describe("JWT", () => {
  const userID = "3f2a9c1e-7b64-4d8a-9f10-2c5e8b7a4d33";
  const secret = "test-secret";
  const wrongSecret = "not-the-test-secret";

  it("should validate a freshly signed token and return the user ID", () => {
    const token = makeJWT(userID, 3600, secret);
    expect(validateJWT(token, secret)).toBe(userID);
  });

  it("should reject a token signed with a different secret", () => {
    const token = makeJWT(userID, 3600, secret);
    expect(() => validateJWT(token, wrongSecret)).toThrow();
  });

  it("should reject an expired token", () => {
    const token = makeJWT(userID, -3600, secret);
    expect(() => validateJWT(token, secret)).toThrow();
  });

  it("should reject a malformed token string", () => {
    expect(() => validateJWT("not.a.jwt", secret)).toThrow();
  });

  it("should reject a correctly signed token from a different issuer", () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { iss: "not-chirpy", sub: userID, iat: issuedAt, exp: issuedAt + 3600 },
      secret,
    );
    expect(() => validateJWT(token, secret)).toThrow();
  });

  it("should set iss, sub and exp in the payload", () => {
    const token = makeJWT(userID, 3600, secret);
    const decoded = jwt.decode(token) as JwtPayload;
    expect(decoded.iss).toBe("chirpy");
    expect(decoded.sub).toBe(userID);
    expect(decoded.exp).toBe((decoded.iat as number) + 3600);
  });
});

describe("getBearerToken", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";

  it("should extract the token from a well-formed header", () => {
    const req = makeReq({ Authorization: `Bearer ${token}` });
    expect(getBearerToken(req)).toBe(token);
  });

  it("should tolerate extra whitespace around the token", () => {
    const req = makeReq({ Authorization: `Bearer    ${token}   ` });
    expect(getBearerToken(req)).toBe(token);
  });

  it("should accept a case-insensitive scheme", () => {
    const req = makeReq({ Authorization: `bearer ${token}` });
    expect(getBearerToken(req)).toBe(token);
  });

  it("should throw when the header is missing", () => {
    expect(() => getBearerToken(makeReq({}))).toThrow();
  });

  it("should throw when the scheme is not Bearer", () => {
    const req = makeReq({ Authorization: `Basic ${token}` });
    expect(() => getBearerToken(req)).toThrow();
  });

  it("should throw when the token is absent after the scheme", () => {
    expect(() => getBearerToken(makeReq({ Authorization: "Bearer" }))).toThrow();
    expect(() =>
      getBearerToken(makeReq({ Authorization: "Bearer   " })),
    ).toThrow();
  });

  it("should round-trip with makeJWT and validateJWT", () => {
    const secret = "round-trip-secret";
    const userID = "8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
    const signed = makeJWT(userID, 3600, secret);
    const req = makeReq({ Authorization: `Bearer ${signed}` });
    expect(validateJWT(getBearerToken(req), secret)).toBe(userID);
  });
});
