import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";

import { env } from "../src/config/env";
import { USER_ROLES } from "../src/contracts/user.contract";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_ALGORITHM,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
  verifyRefreshTokenHash,
} from "../src/modules/auth/token.service";

/**
 * Token service tests.
 *
 * Secrets come from `.env.test` (loaded by `npm test` via --env-file), so no
 * real secret is ever needed to run these, and none is printed: assertions
 * compare booleans and rejection reasons, never key material.
 */

const USER_ID = "user-1";
const SESSION_ID = "session-1";

/** Signs a token with arbitrary payload/options, for forging test cases. */
const forge = (
  payload: Record<string, unknown>,
  options: jwt.SignOptions = {},
  secret: string = env.JWT_SECRET,
): string =>
  jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ...options,
  });

/** Decodes a JWT segment without verifying. */
const decodeSegment = (token: string, index: 0 | 1): Record<string, unknown> => {
  const segment = token.split(".")[index];
  assert.ok(segment);
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
};

describe("access tokens", () => {
  describe("issuance", () => {
    it("issues a verifiable HS256 token with the expected claim set", () => {
      const issued = issueAccessToken({ userId: USER_ID, role: "student", sessionId: SESSION_ID });

      assert.equal(issued.expiresIn, ACCESS_TOKEN_TTL_SECONDS);
      assert.equal(ACCESS_TOKEN_TTL_SECONDS, 900, "provisional: 15 minutes");
      assert.match(issued.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
      assert.ok(Date.parse(issued.expiresAt) > Date.now());

      const header = decodeSegment(issued.token, 0);
      assert.equal(header["alg"], "HS256");
      assert.equal(header["typ"], "JWT");

      const result = verifyAccessToken(issued.token);
      assert.equal(result.valid, true);

      if (!result.valid) return;

      assert.equal(result.claims.sub, USER_ID);
      assert.equal(result.claims.role, "student");
      assert.equal(result.claims.sid, SESSION_ID);
      assert.equal(result.claims.iss, env.JWT_ISSUER);
      assert.equal(result.claims.aud, env.JWT_AUDIENCE);
      assert.equal(typeof result.claims.iat, "number");
      assert.equal(result.claims.exp - result.claims.iat, ACCESS_TOKEN_TTL_SECONDS);
    });

    it("issues tokens for every authenticated role", () => {
      for (const role of ["student", "teacher", "admin", "super_admin"] as const) {
        const issued = issueAccessToken({ userId: USER_ID, role, sessionId: SESSION_ID });
        const result = verifyAccessToken(issued.token);

        assert.equal(result.valid, true, `${role} should round-trip`);
        if (result.valid) assert.equal(result.claims.role, role);
      }
    });

    it("refuses to mint a token for the `public` role", () => {
      // `public` means "not authenticated" - a token for it is nonsense.
      assert.throws(
        () => issueAccessToken({ userId: USER_ID, role: "public", sessionId: SESSION_ID }),
        /Refusing to issue an access token for role "public"/,
      );
    });

    it("refuses an unknown role, even if a caller forces the type", () => {
      assert.throws(
        () =>
          issueAccessToken({
            userId: USER_ID,
            role: "root" as (typeof USER_ROLES)[number],
            sessionId: SESSION_ID,
          }),
        /Refusing to issue an access token/,
      );
    });

    it("refuses a blank user id or session id", () => {
      assert.throws(
        () => issueAccessToken({ userId: "", role: "student", sessionId: SESSION_ID }),
        /without a user id and session id/,
      );
      assert.throws(
        () => issueAccessToken({ userId: USER_ID, role: "student", sessionId: "  " }),
        /without a user id and session id/,
      );
    });

    it("carries no profile data in the payload", () => {
      const issued = issueAccessToken({ userId: USER_ID, role: "admin", sessionId: SESSION_ID });
      const payload = decodeSegment(issued.token, 1);

      // A JWT is signed, not encrypted - anything here is world-readable.
      assert.deepEqual(
        Object.keys(payload).sort(),
        ["aud", "exp", "iat", "iss", "role", "sid", "sub"],
        "payload must carry nothing beyond the agreed claim set",
      );

      for (const leaked of ["email", "name", "mobile", "password", "permissions", "hash"]) {
        assert.equal(payload[leaked], undefined, `${leaked} must not be a claim`);
      }

      // And the signing secret must never appear in the token.
      assert.equal(issued.token.includes(env.JWT_SECRET), false);
    });
  });

  describe("verification", () => {
    it("accepts a freshly issued token", () => {
      const { token } = issueAccessToken({
        userId: USER_ID,
        role: "teacher",
        sessionId: SESSION_ID,
      });

      assert.equal(verifyAccessToken(token).valid, true);
    });

    it("rejects an expired token", () => {
      // Signed as already expired, well beyond the 5s clock tolerance.
      const token = forge({ role: "student", sid: SESSION_ID }, { subject: USER_ID, expiresIn: -120 });

      const result = verifyAccessToken(token);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "expired");
    });

    it("accepts a token inside the clock-tolerance window", () => {
      // 2 seconds past expiry, within the 5s tolerance for process skew.
      const token = forge({ role: "student", sid: SESSION_ID }, { subject: USER_ID, expiresIn: -2 });

      assert.equal(verifyAccessToken(token).valid, true);
    });

    it("rejects a tampered payload", () => {
      const { token } = issueAccessToken({
        userId: USER_ID,
        role: "student",
        sessionId: SESSION_ID,
      });

      const [header, payload, signature] = token.split(".");
      assert.ok(header && payload && signature);

      // Escalate student -> super_admin, keeping the original signature.
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      claims["role"] = "super_admin";

      const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const tampered = `${header}.${forgedPayload}.${signature}`;

      const result = verifyAccessToken(tampered);
      assert.equal(result.valid, false, "privilege escalation must be refused");
      if (!result.valid) assert.equal(result.reason, "invalid_signature");
    });

    it("rejects a tampered signature", () => {
      const { token } = issueAccessToken({
        userId: USER_ID,
        role: "student",
        sessionId: SESSION_ID,
      });

      const [header, payload] = token.split(".");
      assert.equal(verifyAccessToken(`${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAA`).valid, false);
    });

    it("rejects a token signed with the wrong key", () => {
      const token = forge(
        { role: "admin", sid: SESSION_ID },
        { subject: USER_ID, expiresIn: 900 },
        "a-different-secret-of-sufficient-length-1234567890",
      );

      const result = verifyAccessToken(token);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "invalid_signature");
    });

    it("rejects a wrong issuer", () => {
      const token = forge(
        { role: "student", sid: SESSION_ID },
        { subject: USER_ID, expiresIn: 900, issuer: "https://evil.example.com" },
      );

      const result = verifyAccessToken(token);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "invalid_issuer");
    });

    it("rejects a wrong audience", () => {
      const token = forge(
        { role: "student", sid: SESSION_ID },
        { subject: USER_ID, expiresIn: 900, audience: "some-other-api" },
      );

      const result = verifyAccessToken(token);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "invalid_audience");
    });

    it("rejects an unsigned `alg: none` token", () => {
      // The classic JWT break: strip the signature and declare alg=none.
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: USER_ID,
          role: "super_admin",
          sid: SESSION_ID,
          iss: env.JWT_ISSUER,
          aud: env.JWT_AUDIENCE,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString("base64url");

      const result = verifyAccessToken(`${header}.${payload}.`);
      assert.equal(result.valid, false, "an unsigned token must never be accepted");
    });

    it("rejects a different HMAC algorithm signed with the same secret", () => {
      // HS512 is cryptographically fine but is NOT our configured algorithm.
      // Accepting whatever the header asks for is how algorithm confusion
      // starts, so the allow-list refuses it.
      const token = jwt.sign({ role: "admin", sid: SESSION_ID }, env.JWT_SECRET, {
        algorithm: "HS512",
        subject: USER_ID,
        expiresIn: 900,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      });

      const result = verifyAccessToken(token);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "invalid_algorithm");
    });

    it("rejects an unsupported role even when the signature is valid", () => {
      for (const role of ["public", "root", "superadmin", "SUPER_ADMIN", "", 42, null]) {
        const token = forge({ role, sid: SESSION_ID }, { subject: USER_ID, expiresIn: 900 });

        const result = verifyAccessToken(token);
        assert.equal(result.valid, false, `role ${String(role)} must be refused`);
        if (!result.valid) assert.equal(result.reason, "invalid_role");
      }
    });

    it("rejects missing or malformed claims", () => {
      const cases: Record<string, unknown>[] = [
        { sid: SESSION_ID }, // no role
        { role: "student" }, // no sid
        { role: "student", sid: "" }, // empty sid
        { role: "student", sid: 123 }, // sid wrong type
      ];

      for (const payload of cases) {
        const token = forge(payload, { subject: USER_ID, expiresIn: 900 });
        const result = verifyAccessToken(token);

        assert.equal(result.valid, false, `${JSON.stringify(payload)} must be refused`);
      }

      // No `sub` at all: signed without a subject.
      const noSub = forge({ role: "student", sid: SESSION_ID }, { expiresIn: 900 });
      const result = verifyAccessToken(noSub);
      assert.equal(result.valid, false);
      if (!result.valid) assert.equal(result.reason, "invalid_claims");
    });

    it("rejects structurally invalid input without throwing", () => {
      const junk: unknown[] = [
        undefined,
        null,
        "",
        "   ",
        "not-a-token",
        "a.b",
        "a.b.c.d",
        "....",
        123,
        {},
        [],
        Buffer.from("x"),
      ];

      for (const value of junk) {
        const result = verifyAccessToken(value);
        assert.equal(result.valid, false, `${String(value)} must be refused`);
      }
    });

    it("never leaks the secret or the token through the result", () => {
      const result = verifyAccessToken("tampered.token.value");

      assert.equal(result.valid, false);
      const serialised = JSON.stringify(result);

      assert.equal(serialised.includes(env.JWT_SECRET), false, "secret must not appear");
      assert.equal(serialised.includes("tampered"), false, "token must not be echoed back");
      if (!result.valid) {
        assert.deepEqual(Object.keys(result).sort(), ["reason", "valid"]);
      }
    });
  });
});

describe("refresh tokens", () => {
  describe("generation", () => {
    it("generates 256 bits of entropy, base64url encoded", () => {
      const { token } = generateRefreshToken();

      assert.equal(REFRESH_TOKEN_BYTES, 32, "32 bytes = 256 bits");
      assert.equal(Buffer.from(token, "base64url").length, REFRESH_TOKEN_BYTES);
      // base64url only: URL-safe and header-safe, no padding.
      assert.match(token, /^[A-Za-z0-9_-]+$/);
    });

    it("generates a different token every time", () => {
      const tokens = new Set<string>();
      const hashes = new Set<string>();

      for (let i = 0; i < 200; i += 1) {
        const generated = generateRefreshToken();
        tokens.add(generated.token);
        hashes.add(generated.tokenHash);
      }

      assert.equal(tokens.size, 200, "every token must be unique");
      assert.equal(hashes.size, 200, "every verifier must be unique");
    });

    it("returns a hash alongside the token, and is not a JWT", () => {
      const generated = generateRefreshToken();

      assert.equal(generated.tokenHash, hashRefreshToken(generated.token));
      assert.notEqual(generated.tokenHash, generated.token, "never store the raw token");
      // Opaque, so it carries no readable claims if intercepted.
      assert.equal(generated.token.includes("."), false);
    });

    it("applies the provisional lifetimes, including remember-me", () => {
      const normal = generateRefreshToken();
      const remembered = generateRefreshToken(true);

      assert.equal(normal.expiresInSeconds, REFRESH_TOKEN_TTL_SECONDS);
      assert.equal(REFRESH_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60, "provisional: 7 days");

      assert.equal(remembered.expiresInSeconds, REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS);
      assert.equal(
        REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS,
        30 * 24 * 60 * 60,
        "provisional: 30 days",
      );

      assert.ok(Date.parse(remembered.expiresAt) > Date.parse(normal.expiresAt));
    });
  });

  describe("hashing and verification", () => {
    it("hashes deterministically with SHA-256", () => {
      const { token } = generateRefreshToken();
      const expected = createHash("sha256").update(token, "utf8").digest("hex");

      assert.equal(hashRefreshToken(token), expected);
      assert.equal(hashRefreshToken(token).length, 64, "hex SHA-256");
      // Deterministic: lookups happen BY hash, so it must be stable.
      assert.equal(hashRefreshToken(token), hashRefreshToken(token));
    });

    it("verifies the correct token against its stored hash", () => {
      const { token, tokenHash } = generateRefreshToken();

      assert.equal(verifyRefreshTokenHash(token, tokenHash), true);
    });

    it("rejects an incorrect token", () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();

      assert.equal(verifyRefreshTokenHash(b.token, a.tokenHash), false);
      assert.equal(verifyRefreshTokenHash(`${a.token}x`, a.tokenHash), false);
      assert.equal(verifyRefreshTokenHash(a.token.slice(0, -1), a.tokenHash), false);
    });

    it("rejects a token whose case was altered", () => {
      const { token, tokenHash } = generateRefreshToken();
      const flipped = token
        .split("")
        .map((c, i) => (i === 0 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c))
        .join("");

      if (flipped !== token) {
        assert.equal(verifyRefreshTokenHash(flipped, tokenHash), false);
      }
    });

    it("fails closed on malformed input instead of throwing", () => {
      const { token, tokenHash } = generateRefreshToken();

      for (const bad of [null, undefined, "", 42, {}, []]) {
        assert.equal(verifyRefreshTokenHash(bad, tokenHash), false, "bad token must deny");
        assert.equal(verifyRefreshTokenHash(token, bad), false, "bad stored hash must deny");
      }

      // A length mismatch must not throw out of timingSafeEqual.
      assert.equal(verifyRefreshTokenHash(token, "short"), false);
      assert.equal(verifyRefreshTokenHash(token, `${tokenHash}extra`), false);
    });

    it("supports rotation: a new token invalidates the old verifier", () => {
      // Groundwork for Step 6D. No session store exists yet, so this only
      // proves the primitives behave as rotation requires.
      const original = generateRefreshToken();
      const rotated = generateRefreshToken();

      assert.equal(verifyRefreshTokenHash(original.token, original.tokenHash), true);
      assert.equal(
        verifyRefreshTokenHash(original.token, rotated.tokenHash),
        false,
        "the old token must not verify against the new verifier",
      );
      assert.equal(verifyRefreshTokenHash(rotated.token, rotated.tokenHash), true);
    });
  });
});

describe("JWT configuration", () => {
  it("uses test-only secrets, never a production value", () => {
    assert.equal(env.NODE_ENV, "test");
    assert.match(env.JWT_ISSUER, /test/);
    assert.match(env.JWT_AUDIENCE, /test/);
    assert.ok(env.JWT_SECRET.length >= 32);
    // Asserted by shape, not by printing the value.
    assert.ok(env.JWT_SECRET.includes("test-only"));
  });

  it("pins a single algorithm", () => {
    assert.equal(JWT_ALGORITHM, "HS256");
  });

  /**
   * Production configuration is validated in child processes, because
   * `env.ts` reads the environment once at import time. Each case asserts on
   * the thrown message only - no secret is ever printed.
   */
  const runWithEnv = async (
    vars: Record<string, string>,
  ): Promise<{ ok: boolean; message: string }> => {
    const { execFileSync } = await import("node:child_process");

    const assignments = Object.entries(vars)
      .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
      .join("\n");

    const script = `
      ${assignments}
      try {
        require("./src/config/env");
        console.log(JSON.stringify({ ok: true, message: "" }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, message: String(err.message) }));
      }
    `;

    const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, JWT_SECRET: "", JWT_ISSUER: "", JWT_AUDIENCE: "", NODE_ENV: "" },
    });

    const lines = out.trim().split(/\r?\n/);
    return JSON.parse(lines[lines.length - 1] ?? "{}") as { ok: boolean; message: string };
  };

  it("production refuses to start without JWT_SECRET", async () => {
    const result = await runWithEnv({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.nexelvoria.edu.in",
    });

    assert.equal(result.ok, false, "production must fail closed");
    assert.match(result.message, /JWT_SECRET is required/);
  });

  it("production refuses a secret that is too short", async () => {
    const result = await runWithEnv({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.nexelvoria.edu.in",
      JWT_SECRET: "too-short",
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /too short/);
  });

  it("refuses a placeholder secret even at sufficient length", async () => {
    const result = await runWithEnv({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.nexelvoria.edu.in",
      JWT_SECRET: "replace-with-a-long-random-secret-at-least-32-chars",
    });

    assert.equal(result.ok, false, "a copy-pasted placeholder must never ship");
    assert.match(result.message, /placeholder/);
  });

  it("production refuses a secret marked test-only, at any length", async () => {
    // The test environment generates "test-only-..." secrets; this proves one
    // can never be promoted to a production deploy.
    const result = await runWithEnv({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.nexelvoria.edu.in",
      JWT_SECRET: "TEST-ONLY-a-long-enough-value-for-length-checks-0123456789",
    });

    assert.equal(result.ok, false, "a test-only secret must never ship");
    assert.match(result.message, /test-only/);
  });

  it("production starts with a valid secret", async () => {
    const result = await runWithEnv({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.nexelvoria.edu.in",
      JWT_SECRET: "Zm9yLXRlc3Rpbmctb25seS1ub3QtYS1yZWFsLXNlY3JldC0xMjM0",
    });

    assert.equal(result.ok, true, result.message);
  });

  it("development tolerates a missing secret but warns", async () => {
    const result = await runWithEnv({ NODE_ENV: "development" });

    assert.equal(result.ok, true, "dev must still boot without configuration");
  });

  it("validates a supplied short secret in development too", async () => {
    // So nobody develops against a weak key and promotes it.
    const result = await runWithEnv({ NODE_ENV: "development", JWT_SECRET: "weak" });

    assert.equal(result.ok, false);
    assert.match(result.message, /too short/);
  });
});
